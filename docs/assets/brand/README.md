# Brand assets

This folder stores editable brand source files and generated image files for
Ballin.
Use the [design system](../../design-system.md) for product identity, messaging,
visual principles, and copy guidance. This README only documents the assets in
this folder and the steps for regenerating image files from editable sources.

## GitHub social preview

- Background: `social-preview-background.png`
- Source: `social-preview.svg`
- Generated image: `social-preview.png`
- Size: `1280x640`
- Primary identity: `>_ ballin`
- Supporting copy: `Back up dotfiles. Keep your tools current.`

The social preview follows the high-fidelity raster background plus editable SVG
typography workflow documented in the design system. Keep
`social-preview-background.png` as the unchanged AI-generated background plate,
keep `social-preview.svg` as the editable typography and composition layer, and
treat `social-preview.png` as the GitHub upload artifact. The background plate
and composed export are both `1280x640`.

The social preview follows the wordmark-led direction documented in the design
system. It intentionally stays simpler and more identity-first than the README
hero, with a low-detail graphite background, off-white type, strong negative
space, and a restrained green prompt accent.

When refreshing the PNG, render the SVG at exactly `1280x640` and overwrite
`social-preview.png`. Avoid thumbnail rendering tools that pad or crop the source
artwork.

## README hero

- Background: `readme-hero-background.png`
- Source: `readme-hero.svg`
- Generated image: `readme-hero.png`
- Size: `1600x400`
- Usage: README hero
- Primary identity: `>_ ballin`
- Supporting copy: `Back up dotfiles. Keep your tools current.`

The README hero follows the high-fidelity raster background plus editable SVG
typography workflow documented in the design system. Keep
`readme-hero-background.png` as the unchanged AI-generated background plate,
keep `readme-hero.svg` as the editable typography and composition layer, and
treat `readme-hero.png` as the generated README artifact exported from the
composed SVG. The background plate is `2508x627`; the composed README export is
`1600x400`.

When refreshing the PNG, render the SVG at exactly `1600x400` and overwrite
`readme-hero.png`. Avoid thumbnail rendering tools that pad or crop the source
artwork.
