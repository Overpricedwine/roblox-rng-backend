const express = require("express");
const { Redis } = require("@upstash/redis");

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;
const MAX_INCOMING_BATCH_SIZE = 200;
const REDIS_WRITE_BATCH_SIZE = 20000;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// IDs here remain only in Node memory until there are 200.
const approvedBuffer = new Set();

async function flushFullGroups() {
  while (approvedBuffer.size >= REDIS_WRITE_BATCH_SIZE) {
    const group = [];

    for (const userId of approvedBuffer) {
      group.push(userId);
      approvedBuffer.delete(userId);

      if (group.length === REDIS_WRITE_BATCH_SIZE) {
        break;
      }
    }

    try {
      await redis.sadd("player_pool", ...group);
      console.log(`Stored ${group.length} IDs in player_pool.`);
    } catch (error) {
      // Keep the group in memory if Upstash temporarily fails.
      for (const userId of group) {
        approvedBuffer.add(userId);
      }

      throw error;
    }
  }
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
        error: `Maximum batch size is ${MAX_INCOMING_BATCH_SIZE}`,
      });
    }

    let addedThisRequest = 0;

    for (const userId of userIds) {
      const numericId = Number(userId);

      if (Number.isSafeInteger(numericId) && numericId > 0) {
        const before = approvedBuffer.size;
        approvedBuffer.add(String(numericId));

        if (approvedBuffer.size > before) {
          addedThisRequest += 1;
        }
      }
    }

    await flushFullGroups();

    return res.json({
      success: true,
      received: userIds.length,
      addedToMemoryBuffer: addedThisRequest,
      waitingInMemory: approvedBuffer.size,
    });
  } catch (error) {
    console.error("Failed to process IDs:", error);

    return res.status(500).json({
      success: false,
      error: "Failed to write to database",
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
    console.error("Failed to read from Upstash:", error);

    return res.status(500).json({
      success: false,
      error: "Failed to read database",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});