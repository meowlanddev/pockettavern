# PocketTavern

A SillyTavern-style character chat app for iPhone, built as an installable web app (PWA).
It runs entirely on your device: characters, chats and API keys are stored locally in the browser and
requests go straight from your phone to the AI provider.

## Features
- Import SillyTavern / TavernAI character cards (PNG or JSON, V1/V2/V3) and export them back as PNG cards
- Character editor with alternate greetings, system prompt and post-history overrides
- Streaming chat, swipes (alternate replies), edit/delete/branch messages, multiple chats per character
- Embedded lorebooks (character_book) activated by keywords
- Macros: `{{char}}`, `{{user}}`, `{{time}}`, `{{date}}`, `{{random:a,b}}`, `{{roll:1d20}}`
- Backends: OpenRouter, any OpenAI-compatible API, Claude (Anthropic API)
- Personas, sampler settings, prompt preview, SillyTavern chat import/export (.jsonl), full backup/restore

## Install on iPhone
Open the site in Safari → Share → **Add to Home Screen**.

## Development
No build step. Serve the folder with any static server, e.g. `python3 -m http.server`.
When you change files, bump `CACHE` in `sw.js`.
