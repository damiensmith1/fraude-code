---
title: Fraude Code — Background
tags:
  - project
  - fraude-code
status: active
---

# Background

`fraude-code` is a personal, for-fun project: a hand-rolled miniature clone
of Claude Code, built from scratch to understand what's actually happening
under the hood of an LLM coding agent — the request loop, tool calling, and
how a model reads/writes files and runs shell commands to get things done.

No agent frameworks or SDKs — just an OpenAI-compatible chat completions
call, a small set of hand-written tools, and a loop that keeps feeding tool
results back to the model until it produces a final answer.

## Origin

The repo started life as a scaffold from a CodeCrafters "Build your own
Claude Code" challenge. Once the shape of the exercise was understood, all
CodeCrafters branding and submission plumbing (`.codecrafters/`,
`codecrafters.yml`, the CodeCrafters-flavored README) was stripped out, and
the git history was squashed into a single fresh commit before publishing
to GitHub at `github.com/damiensmith1/fraude-code` — so the public repo
reads as an original personal project, not a challenge submission.

## How it talks to a model

Requests go through [OpenRouter](https://openrouter.ai) via the `openai`
npm package pointed at OpenRouter's OpenAI-compatible endpoint, currently
routed to `anthropic/claude-haiku-4.5`. A native `@anthropic-ai/sdk`
integration was tried and worked, but was reverted in favor of staying on
OpenRouter — see [[design#open-questions|Design → Open Questions]] for
whether that's a long-term choice.

## Current capabilities

- Interactive session CLI: `fraude [session-name]` opens a persistent
  chat session with a landing banner, backed by the same agent loop.
  Sessions persist to disk and resume across launches.
- Three tools the model can call: `Read`, `Write`, `Bash`.
- A global `fraude` command (symlinked into `~/.bun/bin`) that works from
  any working directory, not just the repo root.

## Where this is headed

Interactive session mode shipped — see
[[superpowers/specs/2026-09-06-interactive-session-design|the design spec]]
for how it's built. Remaining open questions (Bash sandboxing, sync vs.
async tool execution) are tracked in
[[design#open-questions|Design → Open Questions]].
