function socketConnect() {
    let ws = new WebSocket(`ws://${window.location.host}`);
    let pingInterval = null;
    let pingTimeout = null;
    let inPing = false;

    ws.onopen = () => {
        console.log('Connected to the server');
        ws.send(JSON.stringify({ debug: 'Hello from the client' }));
        pingInterval = setInterval(() => {
            if (!inPing) {
                inPing = true;
                ws.send(JSON.stringify({ ping: 'ping' }));
                pingTimeout = setTimeout(() => {
                    console.log('Ping timeout');
                    ws.close();
                }, 2500);
            }
        }, 5000);
    }
    
    ws.onclose = () => {
        // try reconnect
        console.log('Disconnected from the server');
        setTimeout(() => {
            clearInterval(pingInterval);
            socketConnect();
        }, 1000);
    }
    
    ws.onmessage = (message) => {
        JSON.parse(message.data, (key, value) => {
            if (key === 'audio') {
                console.log('Received audio from the server');

                const audio = new Audio();
                document.body.appendChild(audio);

                if (!audio.canPlayType('audio/mpeg')) {
                    console.error('Your browser does not support MP3 audio');
                }

                const url = `http://${window.location.host}/${value}`;
                audio.src = url;
                audio.play();
                audio.onended = () => {
                    // remove audio element
                    
    
                    // send ended message to server
                    ws.send(JSON.stringify({ ended: value }));
                    audio.onended = null;
                }
            } else if (key === 'pong') {
                // we're still connected
                inPing = false;
                clearTimeout(pingTimeout);
                console.log('Pong received');
            }
        });
    }

    ws.onerror = (error) => {
        console.error(error);
        ws.close();
    }
}

// async function testTTS(text) {
//     // post to /tts endpoint
//     await fetch('/tts', {
//         method: 'POST',
//         body: text
//     }).then((response) => {
//         console.log('Text-to-speech request sent');
//     }).catch((error) => {
//         console.error(error);
//     });
// }

// async function testMassTTS(textArray) {
//     for (let text of textArray) {
//         await testTTS(text);
//     }
// }

socketConnect();