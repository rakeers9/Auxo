// Public half of the extension's signing key. Chrome derives the extension ID
// from it, so every unpacked build (dev or production, any folder) gets the
// same ID, and the API's CORS_ORIGINS can name it. It is safe to publish; the
// private half isn't needed to load the extension and isn't kept in the repo.
export const EXTENSION_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnhHnsdyit/z53pqTmdbz4W3ezTslmjtsKPyXRyKBOCR9srjdxGDJouv2omQNTDkHDrhCmzSrFm92cJzGGY+WR3zBDF1eQ0ef7IrIFFbEkn5XNyZ0rSRyA6Yn+N5eUfAvY2DOXHQ/+2BnY6AZkKnoCNXTPHrEzl0RJMU91nUwC7QQtiaYdx+bb0q4ATkzcxupufRLoHzuLDCANIiljG01enBK256b67KxWQ+nJIqUQqtAbqFsvNu++zWiyr2+yt8yJP6MgBMgY21MqcWZIGbfFGkc5y1UxOmkfdlenm87gOjZs12z89jCzG4PLbcgBQ6DGXl8ygGIV2gHOxM1vqDUNwIDAQAB";

// The ID Chrome derives from EXTENSION_PUBLIC_KEY. The API allows
// `chrome-extension://<EXTENSION_ID>` in production CORS_ORIGINS.
export const EXTENSION_ID = "imccalmfnleieeiegnofokldkenplaof";
