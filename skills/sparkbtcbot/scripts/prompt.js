// Hidden/echoed stderr prompt, shared by setup and reveal-mnemonic. Prompts on
// stderr (readline defaults to stdout, which is wrong for secrets). Two paths:
//   TTY: raw mode so the terminal does not echo — a `hidden` passphrase must
//        never appear on screen or in pty recordings (tmux/asciinema/script);
//        visible input is echoed exactly once by us.
//   pipe/CI: line-buffered with a carry buffer — piped input delivers several
//        lines in one chunk, and whatever follows the submitted line must feed
//        the NEXT prompt, not vanish with this one's listener.
//        Two ways a pipe can fail to answer, both FAIL LOUD: stdin at EOF with
//        no line (an agent running `setup </dev/null`, or a CI step that piped
//        nothing) used to leave the promise pending forever — Node then exited
//        0 with nothing written, a "success" that set up no wallet. Now it
//        rejects (code PROMPT_EOF). A pipe that stays open but silent (an
//        agent's tool holding stdin) used to hang until something killed it;
//        now it rejects after SPARK_PROMPT_TIMEOUT_MS (default 30 s, code
//        PROMPT_TIMEOUT). Real piped input arrives in milliseconds.
import { stdin, stderr, exit } from "node:process";

let pendingInput = "";
let pipeHintShown = false;

const PIPED_TIMEOUT_MS = (() => {
  const raw = Number(process.env.SPARK_PROMPT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
})();

export async function promptStderr(question, { hidden = false } = {}) {
  stderr.write(question);
  return stdin.isTTY ? promptRawTty(hidden) : promptPipedLine(question);
}

function promptPipedLine(question) {
  return new Promise((resolve, reject) => {
    const takeLine = () => {
      const nl = pendingInput.search(/[\r\n]/);
      if (nl === -1) return null;
      const line = pendingInput.slice(0, nl);
      const crlf = pendingInput[nl] === "\r" && pendingInput[nl + 1] === "\n";
      pendingInput = pendingInput.slice(nl + (crlf ? 2 : 1));
      return line;
    };
    const buffered = takeLine();
    if (buffered !== null) { stderr.write("\n"); resolve(buffered); return; }
    const fail = (code, why) => {
      const e = new Error(
        `stdin is not a terminal and ${why} while waiting for: ${question.trim()} — nothing was read. ` +
        "Run this in a terminal, or provide the value via the documented environment variable (e.g. SPARK_PASSPHRASE).",
      );
      e.code = code;
      return e;
    };
    if (stdin.readableEnded || stdin.destroyed) { stderr.write("\n"); reject(fail("PROMPT_EOF", "is already closed")); return; }
    if (!pipeHintShown) {
      pipeHintShown = true;
      stderr.write("\n(stdin is not a terminal — reading the answer from piped input) ");
    }
    let timer = null;
    const cleanup = () => {
      clearTimeout(timer);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("error", onError);
    };
    const onData = (chunk) => {
      pendingInput += chunk.toString();
      const line = takeLine();
      if (line !== null) {
        cleanup();
        stderr.write("\n");
        resolve(line);
      }
    };
    const onEnd = () => { cleanup(); stderr.write("\n"); reject(fail("PROMPT_EOF", "closed (EOF)")); };
    const onError = (err) => { cleanup(); reject(err); };
    timer = setTimeout(() => { cleanup(); stderr.write("\n"); reject(fail("PROMPT_TIMEOUT", `sent nothing for ${Math.round(PIPED_TIMEOUT_MS / 1000)} s`)); }, PIPED_TIMEOUT_MS);
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onError);
    stdin.resume();
  });
}

function promptRawTty(hidden) {
  return new Promise((resolve, reject) => {
    let input = "";
    let esc = false; // swallow escape sequences (arrow keys etc.)
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    const done = (value) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stderr.write("\n");
      resolve(value);
    };
    const consume = (data) => {
      for (let i = 0; i < data.length; i++) {
        const ch = data[i];
        if (esc) { if (/[a-zA-Z~]/.test(ch)) esc = false; continue; }
        if (ch === "\x1b") { esc = true; continue; }
        if (ch === "\r" || ch === "\n") {
          pendingInput += data.slice(i + (ch === "\r" && data[i + 1] === "\n" ? 2 : 1));
          done(input);
          return true;
        }
        if (ch === "\x03") { // Ctrl-C — raw mode means we handle it ourselves
          stdin.setRawMode(false);
          stderr.write("\n");
          exit(130);
        }
        if (ch === "\x7f" || ch === "\b") {
          if (input.length > 0) {
            input = input.slice(0, -1);
            if (!hidden) stderr.write("\b \b");
          }
          continue;
        }
        if (ch < " ") continue; // other control chars
        input += ch;
        if (!hidden) stderr.write(ch); // raw mode: the tty no longer echoes, we do — once
      }
      return false;
    };
    const onData = (data) => { consume(data); };
    // A previous prompt may have carried over pasted-ahead input — drain it first.
    if (pendingInput) {
      const carried = pendingInput;
      pendingInput = "";
      if (consume(carried)) return;
    }
    stdin.on("data", onData);
    stdin.once("error", (e) => { stdin.setRawMode(false); reject(e); });
    stdin.resume();
  });
}
