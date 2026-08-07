const express = require('express');
const { Redis } = require('@upstash/redis');

const app = express();
app.use(express.json());

// Hardcoded for testing to bypass Windows environment variable bugs
const redis = new Redis({
  url: 'https://healthy-perch-200810.upstash.io',
  token: 'gQAAAAAAAxBqAAIgcDJhYTFiNDM0NDIzMGM0YWRkYTA2ZjAwM2JmZDNiNmI0NA'
});

console.log("Upstash Redis Proxy Client Ready!");

// Endpoint 1: Add discovered active User IDs to your pool
app.post('/add-players', async (req, res) => {
    try {
        const { userIds } = req.body;
        if (!userIds || !Array.isArray(userIds)) {
            return res.status(400).json({ error: "Invalid userIds array" });
        }

        await redis.sadd('player_pool', ...userIds.map(String));
        res.json({ success: true, message: `Added ${userIds.length} IDs to the pool.` });
    } catch (err) {
        console.error("Database Write Error:", err);
        res.status(500).json({ error: "Failed to write to Upstash" });
    }
});

// Endpoint 2: Fetch a completely random player ID for a roll
app.get('/roll-player', async (req, res) => {
    try {
        const randomId = await redis.srandmember('player_pool');
        
        if (!randomId) {
            return res.json({ status: "success", message: "Database pool is empty! Connection working perfectly." });
        }
        res.json({ userId: Number(randomId) });
    } catch (err) {
        console.error("Database Read Error:", err);
        res.status(500).json({ error: "Failed to read from Upstash" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy server active on port ${PORT}`));
