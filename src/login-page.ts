export const loginPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>MCP Memory · Private sign in</title>
    <style>
      :root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; background: #090b10; color: #eff4ff; }
      * { box-sizing: border-box; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at 20% 20%, #15325d 0, transparent 35%), #090b10; }
      main { width: min(100%, 420px); padding: 32px; border: 1px solid #2b3b57; border-radius: 16px; background: #0f1520; box-shadow: 0 18px 60px #0009; }
      p { color: #b8c4d9; line-height: 1.55; }
      label { display: block; margin: 28px 0 8px; font-size: 13px; color: #d3dded; }
      input, button { width: 100%; min-height: 48px; border-radius: 9px; font: inherit; }
      input { border: 1px solid #3b4d6b; padding: 12px; color: inherit; background: #090d15; }
      button { margin-top: 16px; border: 0; cursor: pointer; color: #08101e; font-weight: 700; background: #8cc5ff; }
      button:disabled { opacity: .7; cursor: wait; }
      #status { min-height: 22px; margin: 14px 0 0; color: #ffb4b4; font-size: 13px; }
      .eyebrow { color: #8cc5ff; font-size: 12px; letter-spacing: .12em; text-transform: uppercase; }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">MCP Memory · Private</div>
      <h1>Sign in</h1>
      <p>Enter your private access key to open the memory console. This browser stays signed in for eight hours.</p>
      <form id="login-form">
        <label for="access-key">Access key</label>
        <input id="access-key" name="access-key" type="password" autocomplete="current-password" required autofocus />
        <button type="submit">Open console</button>
        <p id="status" role="status" aria-live="polite"></p>
      </form>
    </main>
    <script>
      const form = document.querySelector("#login-form");
      const status = document.querySelector("#status");
      const key = document.querySelector("#access-key");
      const next = new URLSearchParams(location.search).get("next") || "/";
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = form.querySelector("button");
        button.disabled = true;
        status.textContent = "";
        try {
          const response = await fetch("/auth/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accessKey: key.value, next }),
          });
          if (!response.ok) throw new Error("Invalid access key");
          const result = await response.json();
          location.assign(result.next || "/");
        } catch (error) {
          status.textContent = error.message || "Unable to sign in";
          button.disabled = false;
          key.select();
        }
      });
    </script>
  </body>
</html>`;
