# Kitty

Kitty is a chat agent with one tool (`web_search`) and orchestrator-driven temporal memory.
Node + TS + Express · React (Vite) · Gemini (flash-lite) · Tavily · SQLite.

```bash
cp .env.example .env   # add GEMINI_API_KEY and TAVILY_API_KEY
npm install
npm run dev            # server :3001, web :5173 (proxied)
npm test               # time resolver unit tests
```

Production: `npm run build && npm start` (Express serves `web/dist`).
See DESIGN.md for architecture and `implementationplan.md` acceptance queries (§9).
