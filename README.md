# MeTTa Playground

A fully interactive, client-side web playground for the **MeTTa** language. This frontend transpiles MeTTa code into Prolog and then executes the code directly inside the browser using the **SWI-Prolog WebAssembly (WASM)** engine.

## Features

- 🖥️ **Interactive Code Editor:** Write and edit MeTTa code directly in your browser.
- ⚡ **Client-Side Execution:** Code is executed within a secure Web Worker, ensuring the UI remains responsive and server load is minimized.
- 📦 **No Backend Execution Required:** The entire Prolog runtime is bundled via WASM and executed locally after loading.
- 🎨 **Modern Dark-Mode UI:** Clean and responsive interface featuring separate tabs for Results, Standard Output (stdout), and Standard Error (stderr).
- ⏱️ **Timeout Handling:** Safely kill execution if code takes too long to evaluate, preventing infinite loops.


## Getting Started

1. **Install Dependencies**
   
   To install the required modules ( `swipl-wasm` for the Prolog runtime), open an terminal in this project's root directory and run:

   ```bash
   npm install
   ```

2. **Start the Development Server**

   Since the SWI-Prolog WASM engine relies on downloading external files at execution time (like the transpiler source code) and requires specific `Cross-Origin` headers, you must use the included Express server script instead of just opening `index.html`.

   ```bash
   npm start
   ```

3. **Open the Playground**

   Once the server starts, navigate to [http://localhost:5151/web](http://localhost:5151/web) in your web browser.

## Project Structure

- **`/web`** — The public-facing frontend directory. Contains the main `index.html`, CSS styling, and client-side JavaScript including the Orchestrator and Web Worker responsible for delegating execution tasks.
- **`/src`** — Contains the core `.pl` (Prolog) source logic. These files are asynchronously fetched by the SWI-Prolog WASM engine to prepare the execution environment.

- **`/node_modules`** — Installed NPM packages, which holds the distributed WebAssembly bundle for SWI-Prolog (`swipl-wasm`).

## Security Notes

The `server.js` architecture is specifically designed to isolate your web app. Your local directory tree is generally hidden—only the browser's necessary dependencies inside `/src` and `/node_modules` are intentionally exposed and bound by strict Cross-Origin Isolation policies (`COEP`/`COOP`).
