const express = require("express");
const { Redis } = require("@upstash/redis");

const app = express();

app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;
const MAX_INCOMING_BATCH_SIZE = 250;
const REDIS_WRITE_BATCH_SIZE = 20000;
const ROBLOX_REQUEST_DELAY_MS = Number(
  process.env.ROBLOX_REQUEST_DELAY_MS || 150
);

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// This exists only in the running Node/Render process.
// IDs here are NOT sent to Redis until 200 have been approved.
const approvedBuffer = new Set();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class RobloxRateLimitError extends Error {
  constructor(retryAfterSeconds = 60) {
    super("Roblox rate limit reached");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function retryAfterSeconds(response) {
  const value = Number(response.headers.get("retry-after"));
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 60;
}

function addToApprovedBuffer(userIds) {
  for (const userId of userIds) {
    approvedBuffer.add(String(userId));
  }
}

async function flushFullApprovedGroups() {
  while (approvedBuffer.size >= REDIS_WRITE_BATCH_SIZE) {
    const groupToStore = [];

    // Remove a group from memory before awaiting the network request.
    for (const userId of approvedBuffer) {
      groupToStore.push(userId);
      approvedBuffer.delete(userId);

      if (groupToStore.length === REDIS_WRITE_BATCH_SIZE) {
        break;
      }
    }

    try {
      await redis.sadd("player_pool", ...groupToStore);

      console.log(
        `Stored ${groupToStore.length} approved IDs in player_pool. ` +
        `${approvedBuffer.size} remain only in memory.`
      );
    } catch (error) {
      // Restore them to memory if Redis is temporarily unavailable.
      for (const userId of groupToStore) {
        approvedBuffer.add(userId);
      }

      throw error;
    }
  }
}

async function passesQualityFilters(userId) {
  const numericUserId = Number(userId);

  if (!Number.isSafeInteger(numericUserId) || numericUserId <= 0) {
    return false;
  }

  if (numericUserId >= 10_000_000_000) {
    console.log(`Filtered ${numericUserId}: ID threshold`);
    return false;
  }

  const response = await fetch(
    `https://friends.roblox.com/v1/users/${encodeURIComponent(numericUserId)}/friends/count`,
    {
      headers: {
        Accept: "application/json",
      },
    }
  );

  if (response.status === 429) {
    throw new RobloxRateLimitError(retryAfterSeconds(response));
  }

  // Do not approve users whose check failed.
  if (!response.ok) {
    console.warn(
      `Could not validate ${numericUserId}: Roblox returned ${response.status}`
    );
    return false;
  }

  const data = await response.json();
  const friendCount = Number(data.count);

  if (!Number.isFinite(friendCount) || friendCount < 15) {
    console.log(`Filtered ${numericUserId}: too few friends (${friendCount})`);
    return false;
  }

  console.log(`Approved ${numericUserId}`);
  return true;
}

app.post("/add-players", async (req, res) => {
  try {
    const { userIds } = req.body;

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: "userIds must be a non-empty array",
      });
    }

    if (userIds.length > MAX_INCOMING_BATCH_SIZE) {
      return res.status(413).json({
        success: false,
        error: `Maximum incoming batch size is ${MAX_INCOMING_BATCH_SIZE}`,
      });
    }

    const approvedIds = [];

    for (const userId of userIds) {
      try {
        if (await passesQualityFilters(userId)) {
          approvedIds.push(String(userId));
        }
      } catch (error) {
        if (error instanceof RobloxRateLimitError) {
          // Keep already-approved IDs only in memory.
          addToApprovedBuffer(approvedIds);
          await flushFullApprovedGroups();

          return res.status(429).json({
            success: false,
            status: "rate_limited",
            approvedWaitingInMemory: approvedBuffer.size,
            retryAfterSeconds: error.retryAfterSeconds,
          });
        }

        console.error(`Validation error for ${userId}:`, error.message);
      }

      await delay(ROBLOX_REQUEST_DELAY_MS);
    }

    // IDs are still only in memory at this point.
    addToApprovedBuffer(approvedIds);

    // Only complete 200-ID groups are written to Upstash.
    await flushFullApprovedGroups();

    return res.json({
      success: true,
      submitted: userIds.length,
      approvedThisRequest: approvedIds.length,
      waitingInMemory: approvedBuffer.size,
    });
  } catch (error) {
    console.error("Database write failed:", error);

    if (String(error.message).toLowerCase().includes("maxmemory")) {
      return res.status(507).json({
        success: false,
        status: "database_full",
      });
    }

    return res.status(500).json({
      success: false,
      error: "Failed to process database write",
    });
  }
});

app.get("/roll-player", async (_req, res) => {
  try {
    const randomId = await redis.srandmember("player_pool");

    if (!randomId) {
      return res.json({
        status: "success",
        message: "Pool empty",
      });
    }

    return res.json({
      status: "success",
      userId: Number(randomId),
    });
  } catch (error) {
    console.error("Database read failed:", error);

    return res.status(500).json({
      success: false,
      error: "Failed to read from Upstash",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});