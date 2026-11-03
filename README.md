# PocketTavern

A SillyTavern-style character chat app for iPhone, built as an installable web app (PWA).
It runs entirely on your device: characters, chats and API keys are stored locally in the browser and
requests go straight from your phone to the AI provider.

## Features
- Import SillyTavern / TavernAI character cards (PNG or JSON, V1/V2/V3) and export them back as PNG cards
- **SillyTavern chat-completion presets**: full prompt manager with on/off toggles, prompt editing and reordering,
  in-chat injections at depth, card system-prompt overrides, generation settings; export back to ST format
- **Lorebooks / World Info**: import ST lorebooks; global, per-persona and per-character lorebooks; embedded card lorebooks;
  keywords and regex keys, secondary-key logic, recursion, inclusion groups with priority, character filters,
  probability, all insertion positions (before/after character, @depth with role, examples, outlets)
- **Regex scripts**: ST format; user input / AI output / world info; display-only, prompt-only and permanent; depth limits;
  card-embedded scripts
- **Macros**: `{{char}}`, `{{user}}`, `{{setvar}}`/`{{getvar}}` (+ add/inc/dec, global vars), `{{random::a::b}}`, `{{roll:1d20}}`,
  `{{trim}}`, `{{// comments}}`, `{{mesExamplesRaw}}`, `{{lastMessage}}`, time/date and more
- Model output can contain HTML/CSS (info boards, cards); it is sanitized (DOMPurify) and rendered in a shadow root
- Streaming chat, swipes, edit/delete/branch messages, multiple chats per character, personas
- **Continue** and **Impersonate** (using the preset's continue/impersonation prompts), per-chat **Author's Note** at any depth
- **Group chats**: natural / list / manual reply order, talkativeness, mentions, swap or join cards, muting, "make X speak"
- **Reasoning display**: collapsible thought process from reasoning models (OpenRouter, Claude 4.6+)
- Quick preset switcher inside chats
- **Built-in extensions**: ✨ Enhance My Reply (port of [Enhanced-Replies](https://github.com/setsuna1313/Enhanced-Replies)) and Summarize
- **Quick Replies** (import ST quick reply sets) and a practical subset of **STscript** slash commands
- Lorebook **timed effects**: sticky, cooldown, delay
- Backends: OpenRouter, any OpenAI-compatible API, Claude (Anthropic API)
- Prompt preview, SillyTavern chat import/export (.jsonl), full backup/restore

Not supported: arbitrary third-party ST extensions (they run inside SillyTavern itself; popular ones are rebuilt as built-ins), STscript closures and /if-style control flow.

## Install on iPhone
Open the site in Safari → Share → **Add to Home Screen**.

## Development
No build step. Serve the folder with any static server, e.g. `python3 -m http.server`.
When you change files, bump `CACHE` in `sw.js`.
