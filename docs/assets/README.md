# README example image

Regenerate the `ballin update` image from the repository root. This requires
macOS and a Swift toolchain that provides AppKit.

```sh
node docs/assets/print-readme-update-example.ts | swift -module-cache-path /private/tmp/ballin-update-example-swift-cache docs/assets/render-readme-update-example.swift
```

The printer contains a fixed sample and writes styled terminal text to stdout.
It does not run Ballin maintenance. The renderer converts that ANSI output to
the PNG embedded in the repository README.
