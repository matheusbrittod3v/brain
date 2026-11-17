import base64
import httpx
import unittest
import main


class FakeDocument:
    def export_to_markdown(self):
        return "# Test document\n\nBody text."


class FakeResult:
    document = FakeDocument()


class FakeConverter:
    def __init__(self):
        self.paths = []

    def convert(self, path, **options):
        self.paths.append(path)
        return FakeResult()


class AiWorkerDocumentRouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.previous = main._docling_converter
        self.previous_fallback = main._markitdown_converter
        self.converter = FakeConverter()
        main._docling_converter = self.converter
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()
        main._docling_converter = self.previous
        main._markitdown_converter = self.previous_fallback

    async def test_upload_is_converted_and_original_path_is_not_used(self):
        response = await self.client.post("/parse-document", json={
            "file_name": "safe-policy.docx",
            "content_base64": base64.b64encode(b"synthetic DOCX bytes").decode()
        })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"markdown": "# Test document\n\nBody text.", "engine": "docling"})
        self.assertTrue(self.converter.paths)
        self.assertTrue(self.converter.paths[0].endswith(".docx"))

    async def test_route_rejects_path_names_and_oversized_request_before_conversion(self):
        bad_name = await self.client.post("/parse-document", json={
            "file_name": "../secret.pdf", "content_base64": base64.b64encode(b"x").decode()
        })
        self.assertEqual(bad_name.status_code, 422)
        oversized = await self.client.post("/parse-document", json={
            "file_name": "safe.pdf", "content_base64": "A" * (24 * 1024 * 1024 + 1)
        })
        self.assertEqual(oversized.status_code, 413)
        self.assertEqual(self.converter.paths, [])

    async def test_route_fails_closed_when_docling_is_unavailable(self):
        main._docling_converter = None
        main._markitdown_converter = None
        response = await self.client.post("/parse-document", json={
            "file_name": "safe.pdf", "content_base64": base64.b64encode(b"x").decode()
        })
        self.assertEqual(response.status_code, 503)

    async def test_route_uses_markitdown_when_docling_is_unavailable(self):
        class FallbackResult:
            text_content = "# MarkItDown fallback"

        class FallbackConverter:
            def convert(self, _path):
                return FallbackResult()

        main._docling_converter = None
        main._markitdown_converter = FallbackConverter()
        response = await self.client.post("/parse-document", json={
            "file_name": "safe.csv", "content_base64": base64.b64encode(b"header,value").decode()
        })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"markdown": "# MarkItDown fallback", "engine": "markitdown"})


if __name__ == "__main__":
    unittest.main()
