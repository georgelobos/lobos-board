---
description: How to run LOBOS-BOARD with ngrok for public access
---

# Running LOBOS-BOARD with ngrok

This workflow allows students to access your whiteboard from any device/location via the internet.

## Prerequisites
1. Install ngrok: https://ngrok.com/download
   - Windows: Download and extract `ngrok.exe`
   - Or use: `choco install ngrok` (if you have Chocolatey)
   - Or use: `winget install ngrok` (Windows 11)

2. (Optional) Create free ngrok account for persistent URLs: https://dashboard.ngrok.com/signup

## Steps

### 1. Start the Socket.IO Server
```bash
cd server
npm run dev
```
Wait for: `SUCCESS: Server running on http://127.0.0.1:3003`

### 2. Start ngrok Tunnel
Open a **new terminal** and run:
```bash
ngrok http 3003
```

You'll see output like:
```
Forwarding  https://abc123.ngrok.io -> http://localhost:3003
```

**Copy the HTTPS URL** (e.g., `https://abc123.ngrok.io`)

### 3. Update .env File
Open `d:\DOCUMENTOS\APPS-JLVM\LOBOS-BOARD\.env` and update:
```
VITE_SOCKET_URL=https://abc123.ngrok.io
```
(Replace with your actual ngrok URL)

### 4. Start the Frontend
Open a **third terminal**:
```bash
npm run dev
```

### 5. Share Your Board
1. Open the app in your browser (usually `http://localhost:5173`)
2. Click the Share button (🔗)
3. Copy the link
4. Send it to your students

## Important Notes
- **Keep all 3 terminals running** (server, ngrok, frontend)
- **ngrok URL changes** each time you restart it (free version)
- If ngrok URL changes, update `.env` and restart frontend
- For persistent URL, sign up for ngrok account and use: `ngrok http 3003 --domain=your-domain.ngrok.io`

## Troubleshooting
- **"Connection refused"**: Make sure server is running on port 3003
- **"Invalid URL"**: Check that `.env` has the correct ngrok HTTPS URL
- **Students can't connect**: Verify ngrok is running and URL is correct
