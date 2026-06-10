# 🚀 Base Invaders — Base Mini App

A space shooter game built as a **Farcaster Mini App** on Base. Shoot aliens,
collect $BASE power-ups, freeze enemies, fire laser beams, and climb the
global leaderboard — all with your Base wallet, no sign-in required.

---

## Deploy in 4 Steps

### 1. Push to GitHub
- Create a new repo on github.com (name it `base-invaders`)
- Upload all files from this zip into the repo root
- Add placeholder images to `public/`:
  - `icon.png` — 200×200px square (your game logo)
  - `preview.png` — 1200×628px (shown in Warpcast casts)
  - `splash.png` — 200×200px (shown while app loads)

### 2. Deploy to Vercel
1. Go to **vercel.com** → Add New Project
2. Import your `base-invaders` GitHub repo
3. Framework preset: **Create React App**
4. Click **Deploy**
5. Copy your live URL (e.g. `https://base-invaders.vercel.app`)

### 3. Update your URLs
Edit `public/.well-known/farcaster.json` — replace every
`https://YOUR_DEPLOYED_URL` with your actual Vercel URL.

### 4. Sign the Farcaster manifest
1. Open **Warpcast** on your phone
2. Go to **Settings → Developer → Mini Apps**
3. Enter your deployed Vercel URL
4. Warpcast generates a signed `accountAssociation` block
5. Copy it into `public/.well-known/farcaster.json`
6. Push the update to GitHub — Vercel auto-redeploys

---

## How Wallet Connect Works

- **Inside Warpcast / Coinbase Wallet**: wallet auto-connects via Farcaster SDK,
  no input needed
- **In a browser**: user pastes their Base wallet address manually
- Scores are saved to localStorage, keyed by wallet address
- Basenames are resolved automatically and shown on the leaderboard

---

## Game Features

| Feature | Detail |
|---------|--------|
| 🚀 Ship | Canvas-drawn, tilts on movement |
| 👾 Aliens | One unified shape, 10 colour palettes per wave |
| 🔵 $BASE Fruit | Rare · 2× score multiplier for 9s |
| ❄️ Freeze Fruit | Rarer · Freezes all enemies for 5s |
| ⚡ Laser Fruit | Rarest · Stores 1 · Double-tap to fire · 10s beam |
| 📈 Waves | Every 10 kills = new wave, faster enemies |
| 🎵 Music | Procedural synth bass + drums via Web Audio API |
| 🏆 Leaderboard | Global · Ranked by score · Basenames displayed |
| ⏸ Pause | Tap pause or press ESC |

---

## Local Development

```bash
npm install
npm start
```

Open http://localhost:3000

## Production Build

```bash
npm run build
```

Upload the `build/` folder to any static host. 
