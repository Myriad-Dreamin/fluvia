---
layout: home

hero:
  name: fluvia
  text: An asynchronous dataflow runtime for LLM agents
  tagline: Sessions are recorded. A recording can be cut at any line, replayed on a virtual clock with one thing changed, and scored. Replays run without a model.
  image:
    src: /logo.svg
    alt: fluvia
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Demo
      link: https://myriad-dreamin.github.io/fluvia/
    - theme: alt
      text: GitHub
      link: https://github.com/Myriad-Dreamin/fluvia

features:
  - title: Calls that answer instantly
    details: An agent writes one JS-syntax call per line. The runtime binds two handles, answers, and schedules the work. Nothing ever waits or polls.
    link: /guide/runtime
  - title: Two channels per call
    details: Every call binds a value handle and an error handle; exactly one becomes ready. Recovery is a line submitted alongside the happy path, not a retry loop.
    link: /guide/runtime
  - title: A session is a record
    details: Every line, settlement and notification goes into the trace — with the conversation, when a model drove it. Restore it to any point and continue.
    link: /reference/trace
  - title: Cut, then change one thing
    details: A case names a recording, a cut, and the single difference — concurrency, an edited line, a swapped implementation, or a lane handed to an agent.
    link: /guide/cases
  - title: Judged, not diffed
    details: Judges are predicates over the replayed world. The diff against the recording is one judge among them, not the verdict.
    link: /reference/case-api
  - title: Free by default
    details: A replay costs nothing and runs on a virtual clock. Only a takeover driver that samples a model spends anything, and the totals line counts those runs separately.
    link: /guide/cases
---
