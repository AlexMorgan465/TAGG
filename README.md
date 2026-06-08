# PDF Batch Classifier

Classifies a folder of PDFs into `TAGGED` and `UNTAGGED` folders.

The script uses Mozilla PDF.js page structure trees. A PDF is classified as `TAGGED` only when:

- a structure tree is exposed for at least one page
- at least one valid structure role is found, such as `P`, `H1`, `Figure`, `Table`, `TD`, `TR`, `TH`, `Span`, or `LBody`
- at least one MCID-linked content item is present

If any of those checks fail, the PDF is classified as `UNTAGGED`.

## Install

```powershell
npm install
```

## Run

```powershell
node batch-classify-pdfs.js "C:\path\to\pdf-folder"
```

After running, the input folder will contain:

```text
TAGGED\
UNTAGGED\
```

By default, files are moved. To copy instead:

```powershell
node batch-classify-pdfs.js "C:\path\to\pdf-folder" --copy
```

To include subfolders and write a JSON report:

```powershell
node batch-classify-pdfs.js "C:\path\to\pdf-folder" --recursive --json report.json
```

## Notes

This is the Node/PDF.js implementation requested in the spec. For enterprise or banking PDFs, the more reliable architecture is still:

```text
Node.js batch runner
  -> Java PDF engine CLI
  -> returns TAGGED/UNTAGGED, MCID count, tag count, and validation notes
```

PDF.js exposes a usable structure tree through `page.getStructTree()`, but it is not a full PDF/UA validator. Use PDFBox, iText, PAC, or the existing Java engine when you need conformance-grade decisions.
