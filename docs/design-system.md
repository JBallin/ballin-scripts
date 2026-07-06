# Ballin design system

This document is the durable source of truth for Ballin identity, product
messaging, visual direction, and brand asset guidance. It is meant to guide
README, docs, CLI help, social preview, hero, website, and profile copy
work without reopening broad visual exploration.

Use this document to decide what Ballin should say and feel like. README,
CLI help, brand assets, website copy, and profile copy should apply this
guidance while preserving the job of each surface:

- README onboarding and install flow should prioritize practical first-run
  clarity.
- README hero/banner assets should prioritize legitimacy, trust, and workflow
  fit.
- Restore, replay, and bootstrap language should stay conservative until those
  capabilities exist.

## Naming

- Repository and package identity: `ballin-scripts`
- Product name in prose: Ballin
- CLI identity: `ballin`
- Primary visual wordmark: lowercase `ballin`
- Signature/contextual lockup: `>_ ballin`

Use Ballin for user-facing product language. Use `ballin-scripts` when precision
matters for the repository, package, local checkout, install paths, or
self-update behavior.

Prompt and cursor motifs are useful accents, but they do not need to appear in
every asset. Avoid mascot-first, badge-first, or complex logo-first branding for
now.

## Copy system

Downstream copy should derive from upstream guidance instead of inventing new
positioning for each surface:

```text
Brand principles
  -> Product truth
  -> Tagline
  -> Elevator pitch
  -> README opening
  -> Resume / LinkedIn
  -> Website / blog / talks
```

Canonical copy:

- Product truth: `Ballin keeps a macOS development environment backed up and current.`
- Capability tagline: `Back up your dotfiles and update your macOS development environment.`
- Short hero line: `Back up dotfiles. Keep your tools current.`
- Elevator pitch: Ballin backs up development-environment state and automates
  routine updates for macOS developer tools.

The capability tagline is currently used by the `ballin` help/overview output.
Treat CLI help as a downstream product surface that should stay aligned with
this document.

Surface guidance:

- CLI help/overview should make the product purpose clear before listing
  commands.
- README opening copy should apply the product truth while adding enough
  implementation detail for first-time readers.
- README onboarding should prefer practical clarity, such as prerequisites
  and install expectations, over a more promotional tagline.
- Resume, LinkedIn, website, blog, and talk descriptions should derive from the
  product truth rather than introducing a new position.

Broader explanatory copy can discuss repeatable rebuilds and auditable setup
with nuance. Visual assets and short hero copy should stay concrete and avoid
future-state restore claims.

Non-canonical product/help-output candidates:

- `Keep your macOS development environment backed up and current.`
- `Preserve, update, and verify your macOS development environment.`

Do not promote these candidates without intentionally updating the relevant
downstream surfaces.

## Voice

Ballin copy should be direct, concrete, and calm. Prefer plain capability
language over marketing claims. Explain benefits through what the tool actually
does: backing up development-environment state, automating routine updates, and
making rebuilds more repeatable and auditable.

Prefer:

- backed up and current
- private backups
- routine updates
- Ballin-managed environment
- repeatable and auditable, when there is room for nuance

Avoid:

- hype-first claims
- vague "magic" language
- "sync" language that implies cross-device or bidirectional behavior
- restore/replay language before that behavior exists

## Visual identity

Ballin should feel premium, calm, restrained, developer-native, macOS-first,
quietly reliable, crafted, approachable, and technically serious.

Prefer:

- confidence over excitement
- craftsmanship over marketing
- clarity over cleverness
- a wordmark-led identity
- dark graphite or slate backgrounds
- off-white typography
- restrained green accents
- generous negative space
- subtle texture and premium material feel
- terminal-inspired details, not terminal-dominated layouts

The visual identity should feel closer to thoughtful macOS developer tooling
than hacker, cyberpunk, or generic SaaS art.

Avoid:

- cyberpunk or neon overload
- fake dashboards or fake product UI
- dense terminal screenshots or help-output art
- workflow diagrams and architecture illustrations as primary visuals
- generic SaaS visuals
- feature overload
- Apple hardware advertising or product-glamour-shot compositions
- mascot-first branding

## Asset hierarchy

Different assets have different jobs:

- Social preview: recognition and first impression. Keep it simple, polished,
  and identity-first.
- README hero: legitimacy, trust, and workflow fit. It can be more atmospheric
  than the social preview, but should be quieter and support the documentation.
- README and docs: explanation. Detailed product behavior belongs in text, not
  inside image assets.

The social preview is the identity-first asset. The README hero is informed by
this guidance rather than broad visual exploration.

README onboarding and top-copy changes should use the copy system here when
evaluating the README opening, prerequisites, installation wording,
documentation links, or troubleshooting pointers.

## README hero guidance

The README hero should optimize for the feeling that a macOS development
environment is quietly handled and ready to work in. Copy explains what Ballin
does; the visual should create trust, atmosphere, and workflow fit.

The README hero supports the written README. It should not replace the README's
explanation or try to show Ballin's internal product state.

A calm macOS developer workspace is an appropriate direction because Ballin is
macOS-specific. The failure mode is making Apple hardware the hero instead of
Ballin.

If workspace imagery is used:

- keep Ballin as the identity anchor
- use macOS developer cues as context, not as product advertising
- avoid cluttered desk scenes
- avoid raw CLI output, fake UI, dashboards, status cards, checklists, or
  workflow diagrams
- avoid dense terminal screenshots and feature overload
- avoid command-name-centered artwork
- avoid literal product-state cards such as "development environment under
  control"
- avoid making a symbolic object the focal point if it competes with the
  wordmark or makes the viewer ask what the object is

Do not include installation commands in README hero artwork.

### Feature strips

A README hero may include a very small feature strip if it improves the
composition, but it is optional.

If used, prefer short capability-level labels only. Avoid descriptions, install
commands, or future-state claims.

Preferred v1 labels:

```text
CLI first · Private backups · Routine updates · macOS native
```

Avoid labels such as `Always current`, `Restore-ready`, `Rebuild anywhere`, or
`Install in 60 seconds` because they can overstate current behavior or distract
from the hero.

If removing the strip makes the hero calmer and stronger, remove it.

## Source and generated image conventions

Editable source files and generated brand images live under:

```text
docs/assets/brand/
```

Current social preview assets:

```text
docs/assets/brand/social-preview.svg
docs/assets/brand/social-preview.png
```

README hero assets use the same folder:

```text
docs/assets/brand/readme-hero.svg
docs/assets/brand/readme-hero.png
```

README hero images should use a wide `1600x400` format.

Treat editable source files as canonical. Treat PNGs as generated, shareable,
or upload-ready images derived from those sources. Keep asset file lists and
regeneration steps in `docs/assets/brand/README.md`; keep identity and copy
guidance here.

## Claim guardrails

Ballin is currently a backup and update toolkit. It is not a full one-command
machine restore system.

Avoid short copy or visuals that imply:

- one-click restore
- recreate anywhere
- same environment everywhere
- full machine restore
- restore everything
- universal reproducibility
- automatic restore/replay behavior that does not exist yet

Restore, replay, or bootstrap capabilities belong in short brand copy only
after the product supports them. Short brand copy should remain more
conservative than long-form docs.

## Rejected and non-canonical directions

These directions were useful exploration paths but should not become the core
identity without a new decision:

- "collection of scripts" positioning
- cyberpunk terminal art
- dense CLI help screenshots
- fake dashboards or fake product UI
- workflow diagrams and architecture illustrations
- abstract maintenance objects as the core identity
- symbolic focal objects that compete with the Ballin identity
- mascot-first branding
- feature-heavy hero graphics
- generated identicon/avatar systems as the primary brand
- a top-level `BRAND.md`
- `/assets` as the brand asset location
- teal/cyan plus orange color tokens as the primary palette
- a lowercase `b` mark as the primary identity
- immediate generated favicon, avatar, or icon assets
- generated exploration images as a committed archive

The stable direction is calmer, more premium, more macOS-developer-native, and
wordmark-led.

## North star

Optimize for this reaction:

```text
This feels like a premium macOS developer tool.
```

Not:

```text
This has impressive graphics.
```

Every design decision should reinforce the feeling that Ballin quietly handles
development-environment maintenance so the developer can focus on building.
