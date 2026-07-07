# Brand assets

This folder stores editable brand source files and generated image files for
Ballin.
Use the [design system](../../design-system.md) for product identity, messaging,
visual principles, and copy guidance. This README only documents the assets in
this folder and the steps for regenerating image files from editable sources.

## GitHub social preview

- Source: `social-preview.svg`
- Generated image: `social-preview.png`
- Size: `1280x640`
- Primary identity: lowercase `ballin`
- Supporting copy: `Back up your dotfiles and update your macOS development environment`

Keep the SVG editable. Treat the PNG as the GitHub upload artifact.

The social preview follows the wordmark-led direction documented in the design
system. README hero assets use the same identity system, including matte
graphite backgrounds, off-white type, and subtle green accents.

When refreshing the PNG, render the SVG at exactly `1280x640` and overwrite
`social-preview.png`. Avoid thumbnail rendering tools that pad or crop the source
artwork.

Future high-fidelity social preview refreshes may follow the raster background
plate plus editable SVG typography workflow documented in the design system.
The current social preview remains the existing fully vector asset until that
refresh is intentionally designed.

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
