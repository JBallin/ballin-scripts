// Adapted from PR #667 at 64d48dca63fc8833c366539a487d615dbda45d3f.
// Render retained ANSI data only. No Terminal/window capture or product execution.
import AppKit
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}
guard CommandLine.arguments.count == 2,
      let input = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8),
      !input.isEmpty else { fail("Expected UTF-8 ANSI on stdin and an output prefix") }
let prefix = CommandLine.arguments[1]
let pattern = try NSRegularExpression(pattern: "\u{001B}\\[([0-9;]*)m")
let regular = NSFont.monospacedSystemFont(ofSize: 16, weight: .regular)
let boldFont = NSFont.monospacedSystemFont(ofSize: 16, weight: .bold)
let normal = NSColor(calibratedRed: 0.93, green: 0.94, blue: 0.96, alpha: 1)
let colors: [Int: NSColor] = [
    30: .lightGray,
    31: NSColor(calibratedRed: 1, green: 0.43, blue: 0.45, alpha: 1),
    32: NSColor(calibratedRed: 0.30, green: 0.82, blue: 0.47, alpha: 1),
    33: NSColor(calibratedRed: 0.96, green: 0.78, blue: 0.35, alpha: 1),
    34: NSColor(calibratedRed: 0.36, green: 0.64, blue: 1, alpha: 1),
    35: NSColor(calibratedRed: 0.83, green: 0.57, blue: 0.97, alpha: 1),
    36: NSColor(calibratedRed: 0.40, green: 0.82, blue: 0.88, alpha: 1),
    37: normal,
]
var bold = false
var underline = false
var color = normal
func attributes() -> [NSAttributedString.Key: Any] {
    let style = NSMutableParagraphStyle()
    style.lineBreakMode = .byWordWrapping
    return [.font: bold ? boldFont : regular, .foregroundColor: color,
            .underlineStyle: underline ? NSUnderlineStyle.single.rawValue : 0,
            .paragraphStyle: style]
}
var renderedLines: [NSAttributedString] = []
var logicalLines = input.components(separatedBy: "\n")
if logicalLines.last == "" { logicalLines.removeLast() }
for line in logicalLines {
    let source = line as NSString
    let rendered = NSMutableAttributedString(string: "")
    var cursor = 0
    for match in pattern.matches(in: line, range: NSRange(location: 0, length: source.length)) {
        if match.range.location > cursor {
            rendered.append(NSAttributedString(string: source.substring(with: NSRange(location: cursor, length: match.range.location - cursor)), attributes: attributes()))
        }
        let raw = source.substring(with: match.range(at: 1))
        let codes = raw.components(separatedBy: ";").map { component -> Int in
            if component.isEmpty { return 0 }
            guard let code = Int(component) else { fail("Unsupported ANSI styling number") }
            return code
        }
        for code in codes {
            switch code {
            case 0: bold = false; underline = false; color = normal
            case 1: bold = true
            case 4: underline = true
            case 22: bold = false
            case 24: underline = false
            case 30...37: color = colors[code]!
            case 39: color = normal
            default: fail("Unsupported ANSI styling code: \(code)")
            }
        }
        cursor = match.range.location + match.range.length
    }
    if cursor < source.length {
        rendered.append(NSAttributedString(string: source.substring(from: cursor), attributes: attributes()))
    }
    if rendered.string.unicodeScalars.contains(where: { ($0.value < 32 && $0 != "\n") || (127...159).contains($0.value) }) {
        fail("Unsupported terminal control sequence; normalize explicitly before rendering")
    }
    renderedLines.append(rendered)
}
let width = 1280
let margin: CGFloat = 48
let contentWidth = CGFloat(width) - margin * 2
let options: NSString.DrawingOptions = [.usesLineFragmentOrigin, .usesFontLeading]
var pages: [[(NSAttributedString, CGFloat)]] = [[]]
var used: CGFloat = 0
for line in renderedLines {
    let size = line.boundingRect(with: NSSize(width: contentWidth, height: 100000), options: options)
    let height = max(28, ceil(size.height) + 8)
    guard height <= 1400 else { fail("One logical line is too tall; normalize the capture explicitly") }
    if used + height > 1400 {
        pages.append([])
        used = 0
    }
    pages[pages.count - 1].append((line, height))
    used += height
}
var filenames: [String] = []
for (index, page) in pages.enumerated() {
    let height = max(240, Int(ceil(page.reduce(0) { $0 + $1.1 } + margin * 2)))
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
                                       bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                       isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let graphics = NSGraphicsContext(bitmapImageRep: bitmap) else { fail("Cannot allocate image") }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = graphics
    graphics.cgContext.setFillColor(NSColor(calibratedRed: 0.105, green: 0.118, blue: 0.141, alpha: 1).cgColor)
    graphics.cgContext.fill(CGRect(x: 0, y: 0, width: width, height: height))
    var top = CGFloat(height) - margin
    for (line, lineHeight) in page {
        top -= lineHeight
        line.draw(with: NSRect(x: margin, y: top, width: contentWidth, height: lineHeight), options: options)
    }
    NSGraphicsContext.restoreGraphicsState()
    let filename = String(format: "%@-%03d.png", prefix, index + 1)
    guard let png = bitmap.representation(using: .png, properties: [:]) else { fail("Cannot encode image") }
    try png.write(to: URL(fileURLWithPath: filename))
    filenames.append(URL(fileURLWithPath: filename).lastPathComponent)
}
let report: [String: Any] = ["text": renderedLines.map { $0.string }.joined(separator: "\n") + (input.hasSuffix("\n") ? "\n" : ""),
                           "pages": filenames, "width": width,
                           "presentation": "Rendered ANSI; visual wrapping only; logical text and order unchanged"]
try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: prefix + ".json"))
