# Glowguard

A dependency-free browser tower defense game built with HTML, CSS, JavaScript, and Canvas.

## Play

Serve this directory (ES modules require an HTTP origin in ordinary browsers):

```sh
python3 -m http.server 8080
```

Then visit `http://localhost:8080`. Choose Scout or Cannon, click open ground to build, and press **Start wave**. Click a placed tower to upgrade it. Protect the core through five waves. **Space** starts a wave and **P** pauses; the sidebar also provides pause and restart controls.

## Verify

```sh
node test.mjs
node browser-test.mjs
```

The first command checks the deterministic game rules. The second launches the existing system Chrome, exercises actual page controls in a browser-side test mode, and saves `tower-defense.png`.
