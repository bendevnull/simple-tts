require('dotenv').config();

const express = require('express');
const app = express();
const pm2 = require("@pm2/io");

const crypto = require('crypto');

const fs = require('fs');

const gtts = require('gtts');

const { createServer } = require('http');
const { WebSocketServer } = require('ws');

const server = createServer(app);
const wss = new WebSocketServer({ server });

const ComfyJS = require("comfy.js");

var nowPlaying = null;

const queue = [];
pm2.metric({
    name: "Messages in Queue",
    value: () => queue.length
})

pm2.metric({
    name: "Connected Clients",
    value: () => wss.clients.size
})

var currentQueueTime = 0;
const queueInterval = 2500;

const bannedWords = [
    "nigg",
    " n word",
    "fagg",
    "retard",
    "beaner",
    "chink",
    "tranny",
    "trannie"
]

const messageHold = [];

function processQueue() {
    if (currentQueueTime >= 30000) {
        console.log("TTS: Queue time exceeded, clearing nowPlaying")
        nowPlaying = null;
        currentQueueTime = 0;
    }

    if (nowPlaying === null && queue.length > 0) {
        nowPlaying = queue.shift();
        if (wss.clients.length == 0) {
            console.log("TTS: No clients are connected, putting message back at top of queue")
            queue.unshift(nowPlaying);
            nowPlaying = null;
        } else {
            wss.clients.forEach((client) => {
                client.send(JSON.stringify({ audio: `${nowPlaying}.mp3` }));
            });
        }
    } else if (nowPlaying !== null) {
        currentQueueTime += queueInterval;
    }
}

function auth(req, res, next) {
    const auth = req.headers['authorization'];
    if (!auth) {
        res.set('WWW-Authenticate', 'Basic realm="Secure Area"');
        return res.status(401).send('Authentication required.');
    }

    if (!fs.existsSync('users.json')) {
        return res.status(500).send('Authentication database not initialized. Contact the server administrator.');
    }

    const users = JSON.parse(fs.readFileSync('users.json', 'utf8'));

    if (users.length === 0) {
        return res.status(500).send('No users found in the authentication database. Contact the server administrator.');
    }

    const [username, password] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
    const user = users.find(user => user.username === username && user.password === password);

    if (!user) {
        return res.status(403).send('Forbidden');
    }

    next();
}

function generateTTS(text) {
    if (checkForBannedWords(text)) {
        console.log("Found banned word")
        return
    }
    const tts = new gtts(text, 'en');
    const uuid = crypto.randomUUID();
    tts.save(`static/${uuid}.mp3`, function (err, result) {

        if (err) {
            return console.error(err);
        }
        
        console.log("Text has been converted to audio");
        // add to queue
        queue.push(uuid);
    })
}

function checkForBannedWords(message) {
    for (let i = 0; i < bannedWords.length; i++) {
        // check with regex
        if (message.match(new RegExp(bannedWords[i], 'gi'))) {
            return true;
        }
    }
    return false;
}

function removeCheerMessage(message) {
    return message.replace(/Cheer[0-9]+/gi, '');
}

wss.on('connection', (ws) => {
    console.log('Client connected');
    
    ws.on('message', (message) => {
        JSON.parse(message.toString(), (key, value) => {
            switch(key) {
                case "debug":
                    console.log(`Debug => ${value}`)
                    break
                case "ended":
                    console.log(`TTS: TTS Ended => ${value}`);
                    if (fs.existsSync(`static/${value}`)) {
                        fs.rmSync(`static/${value}`);
                    }
                    nowPlaying = null;
                    break
                case "ping":
                    ws.send(JSON.stringify({ pong: 'pong' }));
                    break
            }
        })
    });
});

wss.on('close', () => {
    console.log('Client disconnected');
});

app.use('/', express.static('static'));

app.get('/dashboard', auth, (req, res) => {
    res.sendFile(__dirname + '/dashboard/index.html');
});

app.post('/api/restart', auth, (req, res) => {
    res.send('Restarting server...');
    setTimeout(() => {
        process.exit(0);
    }, 1000);
})

app.post('/tts', (req, res) => {
    res.send('Text-to-speech endpoint');
    req.on('data', async (data) => {
        console.log(`TTS: Received data => ${data}`);
        generateTTS(data.toString());
    });
});

server.listen(3000, () => {
    console.log('Server started on http://localhost:3000');
    ComfyJS.Init(process.env.TWITCH_USER, process.env.TWITCH_TOKEN);

    ComfyJS.onReward = (user, reward, cost, message, extra) => {
        console.log(`Reward: ${user} redeemed ${reward} for ${cost} with message: ${message}`);
        if (reward == "TTS") {
            generateTTS(message);
        }
    };

    ComfyJS.onCheer = (user, message, bits, flags) => {
        console.log(`Cheer: ${user} cheered ${bits} bits with message: ${message}`);
        generateTTS(`${user} cheered ${bits} ${bits == 1 ? "bit" : "bits" } with message: ${removeCheerMessage(message)}`);
    }

    // ComfyJS.onChat = (user, message, flags, self, extra) => {
    //     console.log(`Chat: ${user} said "${message}"`);
    //     // generateTTS(`${user} said: ${message}`);
    // }
});

// clean mp3 files
fs.readdirSync('static').forEach((file) => {
    if (file.endsWith('.mp3')) {
        fs.rmSync(`static/${file}`);
    }
});

// loop through queue using setInterval
setInterval(processQueue, queueInterval)