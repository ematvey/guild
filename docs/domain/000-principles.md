# 000 Principles

Guild is a self-hosted agent platform for one organization. Members talk to agents; agents work in server sandboxes and on members' own machines; the organization keeps the data, the keys and the bill. Its core principle:

**The organization owns everything an agent touches, and the server is the one source of truth for it.**

Every part of the design is judged by whether it keeps that true. A conversation, a credential, a model call, a file an agent wrote and a decision a person made all live on the org server, are attributed to someone, and reach every client from there.

## What follows for the product

- **One runtime.** Every conversation is a thread of an agent. There is no separate plain-chat path: a person's own assistant is their personal agent, and it runs on the same path as every shared agent.
- **Agents are shared; conversations are not.** An agent, its workspace and its tools can serve a team. A thread belongs to the one person it was held with, and work done on someone's behalf is recorded as theirs.
- **Work survives.** A turn is durable. A restart resumes it from its recorded steps, a repeated request is admitted once, and a lost machine ends a tool call with an explicit outcome instead of a silent retry.
- **Work runs where it is contained.** Server-side tools run in a gVisor sandbox, never in the server process. Tools on a member's files run on that member's paired machine. Provider keys and integration secrets never leave the server.
- **The organization pays and sees.** Every model request goes through the org gateway, is priced, and is attributed to an org, a user and a team. Every run is recorded, including the ones that said nothing.
- **A person decides what is risky.** A shell command passes static rules first, then an approval gate. Only the thread's owner answers it, and the first answer wins.

## What follows for the design

- **Few concepts, one word each.** A concept has one name, one owner in the code and one canonical shape. Where the code holds it in several places, the translations between them are declared (`scripts/coherence/`). A new need becomes an attribute of an existing concept before it becomes a new one.
- **The server pushes; clients apply.** Any fact a person sees change while the app is open reaches the client as a server-initiated frame. Clients never poll for it and never re-fetch to reconcile.
- **Every place has an address.** Every page, tab and panel a person can reach has its own URL, so a reload, a deep link and the back button land exactly where they were.
- **The contract comes first.** The client–server wire is a schema with fixtures. Both sides are written from it, and a released client keeps working across server releases.
- **Documents read in order.** Each numbered document builds only on the ones before it, so a reader never meets a concept that has not been introduced.

## These documents

The numbered documents describe what the code does now. Decisions and their history live in `PLAN.md`; build, deploy and release live in `README.md`, `docs/deploy-nuances.md` and `docs/clients.md`.
