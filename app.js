require('dotenv').config();

const express = require('express');
const app = express();
const pm2 = require("@pm2/io");

const crypto = require('crypto');

const fs = require('fs');

const gtts = require('gtts');

const { createServer } = require('https');
const { WebSocketServer } = require('ws');

const ssl = {
    key: fs.readFileSync('ssl/privkey.pem', 'utf-8'),
    cert: fs.readFileSync('ssl/cert.pem', 'utf-8'),
    ca: fs.readFileSync('ssl/chain.pem', 'utf-8')
};

const server = createServer(ssl, app);
const wss = new WebSocketServer({ server });

const ComfyJS = require("comfy.js");

const jwt = require('jsonwebtoken');
const secretKey = 'your_secret_key'; // Replace with your actual secret key

const { exec, execSync } = require('child_process');

function loadConfig(file) {
    if (!fs.existsSync(file)) {
        const DEFAULT_CONFIG = {
            twitchUser: "",
            twitchToken: "",
        }

        fs.writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 4))
        return DEFAULT_CONFIG
    }

    return JSON.parse(fs.readFileSync(file))
}

const config = loadConfig("twitch_config.json")

// const passport = require('passport');
// const OAuth2Strategy = require('passport-oauth').OAuth2Strategy;

var channelRewards;
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
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        return res.status(401).send('Authentication required.');
    }

    const token = authHeader.split(' ')[1];
    jwt.verify(token, secretKey, (err, user) => {
        if (err) {
            return res.status(403).send('Forbidden');
        }
        req.user = user;
        next();
    });
}

function restart(req, res) {
    res.send('Restarting server...');
    setTimeout(() => {
        process.exit(0);
    }, 1000);
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

function getCommitHash() {
    try {
        const stdout = execSync('git rev-parse HEAD').toString().trim();
        return stdout;
    } catch (error) {
        console.error('Error getting commit hash:', error);
        return 'unknown';
    }
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

app.get('/dashboard', (req, res) => {
    res.sendFile(__dirname + '/dashboard/dashboard.html');
});

app.post('/api/restart', auth, restart);

app.post('/api/update', auth, (req, res) => {
    // run a git pull to update the app
    res.send('Updating server...');
    exec('git pull', (error, stdout, stderr) => {
        console.log(stdout);
        console.log(stderr);
        if (error !== null) {
            console.log(`exec error: ${error}`);
        }
        restart(req, res);
    });
});

app.post('/tts', (req, res) => {
    res.send('Text-to-speech endpoint');
    req.on('data', async (data) => {
        console.log(`TTS: Received data => ${data}`);
        generateTTS(data.toString());
    });
});

app.post('/api/login', (req, res) => {
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });
    req.on('end', () => {
        const { username, password } = JSON.parse(body);

        if (!fs.existsSync('users.json')) {
            return res.status(500).send('Authentication database not initialized. Contact the server administrator.');
        }

        const users = JSON.parse(fs.readFileSync('users.json', 'utf8'));

        if (users.length === 0) {
            return res.status(500).send('No users found in the authentication database. Contact the server administrator.');
        }

        const user = users.find(user => user.username === username && user.password === password);

        if (!user) {
            return res.status(403).send('Invalid username or password.');
        }

        const token = jwt.sign({ username: user.username }, secretKey, { expiresIn: '12h' });
        res.status(200).json({ token: token });
    });
});

app.get('/api/version', auth, (req, res) => {
    res.status(200).json({ version: getCommitHash() });
});

app.get('/api/users', auth, (req, res) => {
    if (!fs.existsSync('users.json')) {
        return res.status(500).send('Authentication database not initialized. Contact the server administrator.');
    }

    const users = JSON.parse(fs.readFileSync('users.json', 'utf8'));
    res.status(200).json(users);
});

app.post('/api/users', auth, (req, res) => {
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });
    req.on('end', () => {
        const { username, password } = JSON.parse(body);

        if (!username || !password) {
            return res.status(400).send('Username and password are required.');
        }

        if (!fs.existsSync('users.json')) {
            fs.writeFileSync('users.json', JSON.stringify([]));
        }

        const users = JSON.parse(fs.readFileSync('users.json', 'utf8'));

        if (users.find(user => user.username === username)) {
            return res.status(400).send('User already exists.');
        }

        users.push({ username: username, password: password });
        fs.writeFileSync('users.json', JSON.stringify(users, null, 2));

        res.status(201).send('User created successfully.');
    });
});

app.get('/auth/twitch', async (req, res) => {
    res.redirect(`https://id.twitch.tv/oauth2/authorize?client_id=${process.env.TWITCH_CLIENT_ID}&redirect_uri=${process.env.REDIRECT_HOST}/auth/twitch/callback&response_type=token&scope=channel:read:redemptions+user:read:email+user:read:chat+user:write:chat+channel:moderate+channel:read:subscriptions`);
});

async function getToken(code) {
    const response = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            client_id: process.env.TWITCH_CLIENT_ID,
            client_secret: process.env.TWITCH_CLIENT_SECRET,
            code: code,
            grant_type: 'authorization_code',
            redirect_uri: `${process.env.REDIRECT_HOST}/auth/twitch/callback`
        })
    });

    if (!response.ok) {
        console.error('Failed to get token:', response);
        return null;
    }

    const data = await response.json();
    return data.access_token;
}

async function getChannelName(token) {
    const response = await fetch('https://api.twitch.tv/helix/users', {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Client-Id': process.env.TWITCH_CLIENT_ID
        }
    });

    if (!response.ok) {
        console.error('Failed to fetch channel name:', response.statusText);
        return null;
    }

    const data = await response.json();
    if (data.data && data.data.length > 0) {
        return data.data[0].display_name;
    }

    return null;
}

app.get('/auth/twitch/callback', async (req, res) => {
    res.sendFile(__dirname + '/dashboard/callback.html');
});

app.post('/auth/twitch/callback', async (req, res) => {
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });
    req.on('end', async () => {
        const token = req.body.token;

        if (!token) {
            return res.status(400).send('Token is required');
        }

        console.log(`Received token: ${token}`);

        const channelName = await getChannelName(token);

        if (!channelName) {
            return res.status(500).send('Failed to get channel name');
        }

        console.log(`Authenticated as ${channelName}`);
    });
});

server.listen(3000, async () => {
    console.log(`Server started on ${process.env.REDIRECT_HOST}`);
    ComfyJS.Init(config.twitchUser, "oauth:" + config.twitchToken);
    console.log(config.twitchUser, config.twitchToken);

    console.log(channelRewards);

    ComfyJS.onReward = (user, reward, cost, message, extra) => {
        console.log(`Reward: ${user} redeemed ${reward} for ${cost} with message: ${message}`);
        // if (reward == "TTS") {
        //     generateTTS(message);
        // }

        switch(reward) {
            case "TTS":
                generateTTS(message);
                break
            // case "Hydrate!":
            //     generateTTS(`${user} would like to remind you that hydration is important! Make sure to drink water and stay hydrated!`);
            //     break
            // case "Posture Check!":
            //     generateTTS(`${user} would like to remind you to check your posture. Remember to sit up straight and take care of your back!`);
            //     break
            // case "Streeeeeeeeeetch":
            //     generateTTS(`${user} would like to remind you to stretch! It's important to take breaks and stretch your muscles! Especially those forehead muscles!`);
            //     break
            // case "Hold ashgaming's hand":
            //     generateTTS(`Awww, how wholesome! ${user} is now holding Ash's hand!!`);
            //     break
            case "Drop It!":
                generateTTS(`${user} is making you drop your gun!`);
                break
            case "Do A Gun Flip":
                generateTTS(`${user} is making you do a gun flip!`);
                break
        }
    };

    ComfyJS.onFollow

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