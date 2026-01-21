const http = require('http');
const PORT = 3003;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Server Basic OK');
});

server.on('error', (err) => {
    console.error('BASIC SERVER ERROR:', err);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`BASIC SERVER LISTENING ON PORT ${PORT}`);
});
