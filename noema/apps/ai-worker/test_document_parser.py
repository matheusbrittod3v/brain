import base64
import unittest
from pathlib import Path

from document_parser import MAX_DOCUMENT_BYTES, parse_document_upload


class FakeDocument:
    def export_to_markdown(self):
        return "# Extracted\n\nSynthetic document body."


class FakeResult:
    document = FakeDocument()


class FakeConverter:
    def __init__(self):
        self.path = None
        self.bytes = None
        self.options = None

    def convert(self, path, **options):
        self.path = Path(path)
        self.bytes = self.path.read_bytes()
        self.options = options
        return FakeResult()


class DocumentParserTests(unittest.TestCase):
    def test_converts_supported_upload_bytes_and_removes_temporary_file(self):
        converter = FakeConverter()
        content = b"synthetic DOCX bytes"
        result, engine = parse_document_upload("policy.docx", base64.b64encode(content).decode(), converter=converter)
        self.assertEqual(result, "# Extracted\n\nSynthetic document body.")
        self.assertEqual(engine, "docling")
        self.assertEqual(converter.bytes, content)
        self.assertEqual(converter.path.suffix, ".docx")
        self.assertFalse(converter.path.exists())

    def test_uses_markitdown_fallback_when_docling_conversion_fails(self):
        class FailingDocling:
            def convert(self, _path, **_options):
                raise RuntimeError("Docling synthetic failure")

        class FallbackResult:
            markdown = "# Fallback extraction\n\nSpreadsheet row."

        class FallbackConverter:
            path = None

            def convert(self, path):
                self.path = Path(path)
                self.asserted_bytes = self.path.read_bytes()
                return FallbackResult()

        content = b"synthetic XLSX bytes"
        fallback = FallbackConverter()
        markdown, engine = parse_document_upload(
            "sheet.xlsx", base64.b64encode(content).decode(),
            converter=FailingDocling(), fallback_converter=fallback
        )
        self.assertEqual(markdown, "# Fallback extraction\n\nSpreadsheet row.")
        self.assertEqual(engine, "markitdown")
        self.assertEqual(fallback.asserted_bytes, content)
        self.assertFalse(fallback.path.exists())

    def test_rejects_paths_unsupported_extensions_invalid_base64_and_oversized_uploads(self):
        converter = FakeConverter()
        cases = [
            ("../policy.pdf", base64.b64encode(b"x").decode()),
            ("policy.exe", base64.b64encode(b"x").decode()),
            ("policy.pdf", "not-base64!"),
            ("policy.pdf", base64.b64encode(b"x" * (MAX_DOCUMENT_BYTES + 1)).decode()),
        ]
        for file_name, encoded in cases:
            with self.subTest(file_name=file_name, size=len(encoded)):
                with self.assertRaises(ValueError):
                    parse_document_upload(file_name, encoded, converter=converter)
        self.assertIsNone(converter.path)

    def test_removes_temporary_file_when_conversion_raises(self):
        class FailingConverter:
            path = None

            def convert(self, path, **_options):
                self.path = Path(path)
                raise RuntimeError("synthetic conversion failure")

        converter = FailingConverter()
        with self.assertRaises(RuntimeError):
            parse_document_upload("policy.pdf", base64.b64encode(b"pdf").decode(), converter=converter)
        self.assertFalse(converter.path.exists())


if __name__ == "__main__":
    unittest.main()
