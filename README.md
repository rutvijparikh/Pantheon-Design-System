# Pantheon-Design-System

Petpooja Design System.

The token set lives in [`sample-tokens.json`](sample-tokens.json) — colours,
spacing and radii in the W3C design-tokens (`$value` / `$type`) shape.

## Pantheon Copilot (Chrome extension)

[`extension/`](extension/) is a Chrome extension that audits any web page against
those tokens and asks Claude what is worth fixing: it reads the computed styles
of every visible element, reports which colours, spacing values and radii have
drifted off the system, and explains the findings in a side panel.

```bash
cd extension && npm install && npm run build
```

Then load `extension/dist` via **Load unpacked** in `chrome://extensions`. See
the [extension README](extension/README.md) for the full walkthrough,
configuration and what data leaves your machine.
