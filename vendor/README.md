# Local browser dependencies

These files are served from the same origin as the app so opening the app does not
depend on jsDelivr, Google Fonts, or third-party injected scripts.

- `supabase-2.117.3.js`: the unmodified Supabase JS UMD distribution from
  https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/dist/umd/supabase.js.
  License: `supabase-LICENSE.txt` (MIT).
- `fonts.css` and `fonts/*.woff2`: Google Fonts distributions of Inter
  (weights 400–900) and Playfair Display (normal/italic, weights 700–900).
  License: `Inter-OFL.txt` and `Playfair-Display-OFL.txt` (SIL OFL 1.1).
  CSS source: https://fonts.googleapis.com/css2?family=Inter:wght@400..900&family=Playfair+Display:ital,wght@0,700..900;1,700..900&display=swap.

When updating dependencies, update the URLs in `index.html` and the asset list/cache
version in `sw.js` together. Do not insert secrets into these public files.
