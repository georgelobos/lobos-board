import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());

app.get('/ping', (_req, res) => {
    res.send('pong');
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: '*', // Allow all origins for ngrok/public access
        methods: ['GET', 'POST']
    }
});

interface CanvasEvent {
    room: string;
    data: any;
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join-room', (roomId) => {
        socket.join(roomId);
        console.log(`User ${socket.id} joined room ${roomId}`);
        // Request existing state from others in the room
        socket.to(roomId).emit('request-sync', { requesterId: socket.id });
    });

    socket.on('canvas-event', (event: CanvasEvent) => {
        // Broadcast to everyone else in the room
        socket.to(event.room).emit('canvas-event', event);
    });

    socket.on('sync-state', (data: { room: string; state: any; targetId: string }) => {
        // Send state specifically to the requester
        io.to(data.targetId).emit('load-state', data.state);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
});

const PORT = process.env.PORT || 3003;

httpServer.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`ERROR: PORT ${PORT} is already in use.`);
    } else {
        console.error('SERVER ERROR:', err);
    }
    process.exit(1);
});

console.log(`Attempting to start server on http://0.0.0.0:${PORT}...`);

httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`SUCCESS: Server running on http://0.0.0.0:${PORT} (accessible via localtunnel)`);
});

// Diagnostic interval to keep process alive and confirm it hasn't crashed
setInterval(() => {
    if (!httpServer.listening) {
        console.log('WARNING: Server is no longer listening!');
    }
}, 30000);
