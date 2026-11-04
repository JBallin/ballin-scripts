import AppKit
import Darwin
import Foundation

let inputData = FileHandle.standardInput.readDataToEndOfFile()
guard let input = String(data: inputData, encoding: .utf8) else {
    fatalError("Expected UTF-8 terminal output on stdin")
}
guard !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
    fputs("No terminal output received on stdin\n", stderr)
    exit(EXIT_FAILURE)
}
guard CommandLine.arguments.count == 2 else {
    fputs("Pass a temporary PNG output path\n", stderr)
    exit(EXIT_FAILURE)
}

var lines = input.components(separatedBy: "\n")
if lines.last == "" { lines.removeLast() }

let width = 1280
let height = max(720, lines.count * 28 + 100)
let image = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: width,
    pixelsHigh: height,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
)!
let graphics = NSGraphicsContext(bitmapImageRep: image)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = graphics
graphics.cgContext.setFillColor(NSColor(calibratedRed: 0.105, green: 0.118, blue: 0.141, alpha: 1).cgColor)
graphics.cgContext.fill(CGRect(x: 0, y: 0, width: width, height: height))

let escape = "\u{001B}"
let pattern = try NSRegularExpression(pattern: "\u{001B}\\[([0-9;]*)m")
let regularFont = NSFont.monospacedSystemFont(ofSize: 16, weight: .regular)
let boldFont = NSFont.monospacedSystemFont(ofSize: 16, weight: .bold)
let normalColor = NSColor(calibratedRed: 0.93, green: 0.94, blue: 0.96, alpha: 1)
let blueColor = NSColor(calibratedRed: 0.36, green: 0.64, blue: 1, alpha: 1)

for (row, line) in lines.enumerated() {
    let source = line as NSString
    let matches = pattern.matches(in: line, range: NSRange(location: 0, length: source.length))
    let rendered = NSMutableAttributedString(string: "")
    var cursor = 0
    var bold = false
    var blue = false

    for match in matches {
        if match.range.location > cursor {
            let text = source.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            rendered.append(NSAttributedString(string: text, attributes: [
                .font: bold ? boldFont : regularFont,
                .foregroundColor: blue ? blueColor : normalColor,
            ]))
        }

        let codes = source.substring(with: match.range(at: 1)).split(separator: ";").compactMap { Int($0) }
        for code in codes {
            switch code {
            case 0: bold = false; blue = false
            case 1: bold = true
            case 22: bold = false
            case 34: blue = true
            case 39: blue = false
            default: break
            }
        }
        cursor = match.range.location + match.range.length
    }

    if cursor < source.length {
        let text = source.substring(from: cursor)
        rendered.append(NSAttributedString(string: text, attributes: [
            .font: bold ? boldFont : regularFont,
            .foregroundColor: blue ? blueColor : normalColor,
        ]))
    }

    if line.contains(escape) && matches.isEmpty {
        fatalError("Unsupported ANSI escape sequence in terminal output")
    }
    rendered.draw(at: NSPoint(x: 48, y: height - 50 - row * 28))
}

NSGraphicsContext.restoreGraphicsState()
let png = image.representation(using: .png, properties: [:])!
let outputPath = CommandLine.arguments[1]
try png.write(to: URL(fileURLWithPath: outputPath))
