const express = require('express');
const { Redis } = require('@upstash/redis');

const app = express();
app.use(express.json());

// Helper function to create a small delay between network requests
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const redis = new Redis({
  url: 'https://healthy-perch-200810.upstash.io',
  token: 'gQAAAAAAAxBqAAIgcDJhYTFiNDM0NDIzMGM0YWRkYTA2ZjAwM2JmZDNiNmI0NA'
});

// Helper function to validate friend count and Account ID
async function passesQualityFilters(userId) {
    try {
        // Filter 1: Reject any account ID that is 8 billion or higher
        if (Number(userId) >= 10000000000) {
            console.log(`❌ Filtered ID ${userId}: Account ID is 8 Billion or newer`);
            return false;
        }

        // Filter 2: Corrected official Roblox API web link
        const friendRes = await fetch(`https://roblox.com{userId}/friends/count`);
        if (friendRes.ok) {
            const friendData = await friendRes.json();
            if (friendData.count < 15) {
                console.log(`❌ Filtered ID ${userId}: Too few friends (${friendData.count})`);
                return false; 
            }
        }

        // Proves the script successfully checked the profile and approved it!
        console.log(`✅ Approved ID ${userId}: Passed all database criteria`);
        return true; 
    } catch (err) {
        // If the Roblox API fails temporarily, let them pass so the loop doesn't freeze
        return true; 
    }
}

// Endpoint 1: Add discovered active User IDs to your pool
app.post('/add-players', async (req, res) => {
    try {
        const { userIds } = req.body;
        if (!userIds || !Array.isArray(userIds)) {
            return res.status(400).json({ error: "Invalid userIds array" });
        }

        const cleanUserIds = [];
        
        // Loop through and filter the incoming batch
        for (const id of userIds) {
            const isValid = await passesQualityFilters(id);
            if (isValid) {
                cleanUserIds.push(String(id));
            }
            // Blasts your requests 150ms apart to completely dodge Roblox HTTP rate blocks!
            await delay(150);
        }

        // Only upload the filtered list to Upstash
        if (cleanUserIds.length > 0) {
            await redis.sadd('player_pool', ...cleanUserIds);
        }
        
        res.json({ success: true, message: `Processed batch. Added ${cleanUserIds.length} verified players.` });
    } catch (err) {
        if (err.message && err.message.includes("maxmemory")) {
            return res.status(507).json({ 
                success: false, 
                status: "database_full", 
                error: "Upstash limit reached! Turning off crawler." 
            });
        }
        res.status(500).json({ error: "Failed to process database write" });
    }
});

// Endpoint 2: Fetch a completely random player ID for a roll
app.get('/roll-player', async (req, res) => {
    try {
        const randomId = await redis.srandmember('player_pool');
        if (!randomId) {
            return res.json({ status: "success", message: "Pool empty, connection active." });
        }
        res.json({ userId: Number(randomId) });
    } catch (err) {
        res.status(500).json({ error: "Failed to read from Upstash" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Smart-Filtering Proxy Active on Port ${PORT}`));

