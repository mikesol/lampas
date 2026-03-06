---

title: Turn Any API Call into a Webhook  
published: false  
description: A small step for agents, a giant leap for agent-kind  
tags:  
cover_image: https://dev-to-uploads.s3.amazonaws.com/uploads/articles/85a5fuob6mt8tkgpv70g.webp  
# Use a ratio of 100:42 for best results.  
# published_at: 2026-03-06 06:55 +0000  
---

I abhor webhooks. I've spent an inordinate amount of time over the past fifteen years debugging, monitoring, and recovering from corner cases induced by webhooks.  

And yet, here I am, trying to convince you—if not myself—that literally everything should be a webhook and that REST was a giant mistake. Or, if not a mistake, then a long and winding road that leads to the door of a webhook.  

The fundamental observation is that webhooks are the last step in a long saga to fully decouple _compute_ and _address_. This process started with the load balancer, which spread HTTP requests over a gaggle of servers that could field a request. Serverless was the next logical abstraction and is now the backbone of Vercel, Supabase, and every programmable blockchain.  

Many of us have been in a situation where we use a Serverless function to call a long-running API, like OpenAI, Anthropic, or fal.ai, and let the receiving function idle while it waits for a result. A slight improvement is long-polling on a cron schedule for completion using frameworks like `inngest` or `use workflow`.  

We all know this is dumb, but we do it anyway because it is expedient. But what if we could call the API, exit immediately, and get pinged whenever the action is done? Admittedly, for many services that need to be snappy, like a video game or a stock ticker, this is inefficient. But for most applications, and certainly for applications dealing with AI inference, this is preferable to the current waiting game we're all forced to play.  

The system I'm describing is a webhook—the object of my disdain, of my obsession, and of this article.  

## The Disposable Computer  
What excites me most about the webhook is that it feels like the yin to the yang of the disposable computer. [fly.io](https://fly.io), one of my favorite rhetorical powerhouses in dev tooling, wrote [this](https://fly.io/blog/code-and-let-live/) and [this](https://fly.io/blog/design-and-implementation/) about a mind-bending new concept that they have launched without quite knowing for what it is useful. Called a [`sprite`](https://sprites.dev/), it is a disposable computer. I tried to develop a sprite-like service myself, called Autodock, where I garnered all of 5 users in a span of three months. So either I suck at marketing, the world is not ready for this, or both. But the concept fascinates me. And for computers to be truly disposable, we have to dispose of them with reckless abandon, including _in the middle of HTTP calls_. The only way to resume them is through 🥁 a webhook.  

fly's innovation couldn't come at a better time, as the world has gone gaga for [OpenClaw](https://openclaw.ai/), and for good reason. It goes all-in on a concept around which the community has pussyfooted for the better part of the year—giving an agent unfettered access to compute, memory, and I/O. Taking this to an extreme, the happy agent can execute _anything_, remember _everything_, and hear/see/sense _everywhere_. So the rest of our work is expanding its scope and range. A secondary consideration, which is no less important, is lowering the cost of this setup.  

Disposable computers are interesting because what an agent needs now is different from what it needed five seconds ago. Agents should be adept at cosplay, donning variable abilities to accomplish their tasks. The disposable computer allows them to power up or down as they see fit. And the _webhook_ allows them to resume their agentic business elsewhere in the multiverse of compute instead of being tethered to a hunk of bare metal.  

## Show Me the Protocol  
Imagine you are calling the OpenAI chat completion API.  
Instead of calling:  
```bash
curl https://api.anthropic.com/v1/messages \  
  -H "x-api-key: $ANTHROPIC_API_KEY" \  
  -H "anthropic-version: 2023-06-01" \  
  -H "content-type: application/json" \  
  -d '{  
    "model": "claude-opus-4-5",  
    "max_tokens": 1024,  
    "messages": [{"role": "user", "content": "Hello."}]  
  }'  
```  
You call:  
```bash
curl https://lampas.dev/forward \  
  -H "content-type: application/json" \  
  -d '{  
    "target": "https://api.anthropic.com/v1/messages",  
    "forward_headers": {  
      "x-api-key": "$ANTHROPIC_API_KEY",  
      "anthropic-version": "2023-06-01"  
    },  
    "callbacks": [  
      { "url": "https://hooky-hook-hook.ngrok-free.app" }  
    ],  
    "retry": { "attempts": 3, "backoff": "exponential" },  
    "body": {  
      "model": "claude-opus-4-5",  
      "max_tokens": 1024,  
      "messages": [{"role": "user", "content": "Hello."}]  
    }  
  }'  
```  
The URL `https://lampas.dev/` is just me shilling my snazzy prototype, which is open-source BTW at [`mikesol/lampas`](https://github.com/mikesol/lampas). But the important bit is that it works. You can try it now.  

Let's unpack the work this proxy is doing.  

## Anatomy of a Call  
The key design decision here is that the request contains its own execution plan. It's inspired by [continuation-passing style](https://en.wikipedia.org/wiki/Continuation-passing_style), which I used to love using back when humans wrote code.  

This is done through three fields:  
**target** - the actual API you want to call, forwarded as faithfully as possible.  
**callbacks** - a list of destinations for the response. Each has a url and a protocol. My little PoC does `https://`. But why not `sqs://`, `queue://`, `postgres://` and potentially others? And you get fanout for free because callbacks is an array.  
**retry** - what to do when a callback fails? The receiver might be temporarily down. It may not even exist anymore. Or it might have been recycled by the time the response arrives. So we have to build in some sort of retry with backoff.  

The response envelope looks like this:  
```json
{  
  "lampas_job_id": "prx_abc123",  
  "lampas_status": "completed",  
  "lampas_target": "https://api.anthropic.com/v1/messages",  
  "lampas_delivered_at": "2026-03-06T08:31:00Z",  
  "response_status": 200,  
  "response_headers": { "content-type": "application/json" },  
  "response_body": { ... }  
}  
```  
The original response is preserved verbatim and swaddled in metadata. Correlation IDs can be injected as custom headers on the callback, so the receiver knows which job it's looking at without parsing the body.  

## Beyond REST  
Basically, what I'm arguing for here is the ad-hoc event queue as a corrective, not as a fundamental abstraction. PubNub, SQS, carrier pigeons—they all claim to be able to deliver messages to arbitrary subscribers. But we should be able to opt into that behavior for ANY system. Now, a world may come about in the not-so-distant future where that is no longer necessary because webhooks are the default. But it feels like HTTP and REST are so embedded in our stacks that a corrective will be necessary for the foreseeable future, not unlike Network Address Translation, which was supposed to be a stopgap measure to get around a limitation of IPv4 until we thought of something better. 30 years later, we all know how that turned out.  

But we can go further. Already, Supabase and Drizzle are attempting to transition the database out of the realm of connections and into one of requests and responses. Projects like Electric SQL push this even further, pushing DB triggers and even state into automatic sync. It's entirely possible to imagine a small, persistent bastion that maintains a longstanding connection with a DB, but the developer-facing interface is a webhook.  

At its maximalist state, one can imagine a TypeScript program whose async/await semantics are rewritten as a re-entrant program that is resumed over HTTP triggers. And why not—I mean, who wants to pay for a program to idle around? The agentic economy won't fully take off until compute and address are fully decoupled, and my prediction is that the webhook, the black sheep of networking, will rise from the dustbin of compute to retake the internet by storm.  

## Not Everything Should Be Reachable  
One of the spookiest parts of this model is the idea that you can always be called back. A whole industry has been built around solving this problem, from [Knock](https://knock.app/) to [Zero](https://zero.rocicorp.dev/). What fascinates me is how un-sticky these projects are in spite of their quality. I feel like half of humanity is willing to buy a Mac mini and spend hours obsessively preening over their nascent agent like a Tamagotchi, and yet there's no mass movement towards snappy, bi-directional sync. We're all sort of content with the old crap, which means these projects aren't solving a big enough problem.  

My gut says that the reason for our lack of inertia around sync cuts to the psychology of what an address _is_. OpenClaw invites us to create a nest around a computer that we understandably anthropomorphize given its human-like vibes. There is a feeling of nurturing and protecting something. Services that promise that they can reach us anywhere and anytime, in spite of their usefulness, trigger a sentiment of aggression. No one wants to be permanently on the grid. In other words, none of us _are_ our address, nor do we want to be. I have a feeling that, once people get over the cuteness of their agent calling them at 3AM to ask for a credit card, they'll realize that they've opened the door to a sort of hellscape and try to rein it in.  

Back to webhooks, this leads me to draw a distinction between two types of compute.  
1. What we traditionally call backend, which should be webhook-accessible all the time. How we do that is an implementation detail, but in general, we likely all agree this is ok.  
2. What we traditionally call a frontend. Here, everyone's tired of being accosted by digital solutions that we didn't ask for. We're only cool with things for which we opt in. Meaning that we're perfectly fine waiting 30 minutes for a request to resolve, and it's fine if its resolution is a clever combination of websocket, RTC, long-polling or whatever. But it is not fundamentally different from an API call—it's just a really long one.  

So the "webhooks are everywhere" thesis I'm peddling needs the rejoinder that sometimes, people only want to be reachable for a limited duration. It's the equivalent of giving someone a pager at a restaurant. They're happy to know when their food is done, but they certainly don't want it to follow them home and ask them to come back for Happy Hour every day.  

That being said, frontends are vanishingly thin these days. Nearly every webpage I've looked at for any business I run or hack on has been published ad-hoc to [here.now](https://here.now) to fill a temporary need. The last domain where the frontend actually matters—realms of taste like video games and art projects—will always follow a different set of rules because they're based on fooling us, temporarily, into believing that compute is an Italian-American plumber that jumps on turtle shells and hurls them at waddling triangular brown dudes.  

So the basic pattern—that we should be reachable—remains. The difference is the span during which reachability is appropriate and who needs to consent to it.  

## I'm Hooked  
We are in the early innings of a shift in how compute is structured. The sprite model—cheap, disposable, instantly available—implies that the old model of long-lived processes with permanent addresses is heading the way of the mainframe.  

The thing keeping this model alive, and the thing keeping us smashing our heads against a wall as we use AWS Lambda to call Replicate, is REST. It's the equivalent of how in middle school you got someone to tell someone that you liked them. I mean, that was cute, but it also had its drawbacks. I think we've grown out of it, and we're at the dawn of a new way to communicate. **If you're intrigued, give Lampas a spin or deploy it yourself and let me know what you think!**
