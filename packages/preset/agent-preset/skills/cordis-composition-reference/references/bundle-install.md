# Authoring and installing a workspace bundle

`cordis-plugin-development` (plugins, features, pages, tools) and `editing-cordis-compositions` (agent presets) both deliver change by installing a bundle into the current profile. This file states that shared mechanism once; the patch dialect is in the `cordis-composition-reference` SKILL.md.

## Bundle layout

A workspace bundle directory holds exactly two files.

`<name>/package.json` — a private ESM package that names its patch:

```json
{
  "name": "@local/<name>",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`<name>/cordis.patch.yml` — the Loader patch: an `insert` list for new rows, or a row `id` plus replacement fields to override an existing row. A row's `config` is replaced wholesale, never deep-merged, so an override restates every field the row needs.

## Install

Call `plugin_manager` with `action: install_bundle` and `target` set to the absolute bundle directory. It runs package installation and bundle selection itself; the change is live for every session in that profile and survives restart.

## Do not reproduce these steps

Do not write the profile's `package.json` or `cordis.patch.yml`, create packages under `$DSH_HOME`, or run pnpm in the profile directory. `install_bundle` performs those steps, each hand-made write outside the workspace needs its own approval, and a hand-edited patch or bundle list conflicts with its bookkeeping.
