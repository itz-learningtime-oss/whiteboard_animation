# Your Own Illustrations

Place flattened, passive SVG files here. Reference the filename without `.svg`
as a scene's `primary_visual`, for example `shiva_parvati_lineart`.

Use an accurate, appropriately licensed drawing. This deterministic engine does
not invent cultural imagery, characters, scientific diagrams, or new artwork.

The renderer accepts paths, rectangles, ellipses, circles, polygons, polylines,
lines, nested groups, affine transforms, and `viewBox`. Convert text and clones
to paths in Inkscape before saving. Scripts, CSS classes, `<use>`, filters,
embedded images, gradients, clipping masks, and external references are rejected.

Optional metadata gives exact drawing control:

```xml
<path data-layer="outline" d="..." fill="none" />
<path data-layer="detail" d="..." fill="none" />
<path data-hatch="true" fill-rule="evenodd" d="..." />
<path data-layer="hatch" stroke="#648650" d="..." />
```

Closed shapes with an actual fill receive clipped hatching automatically.
Use `data-hatch="false"` to opt out. Even-odd and non-zero winding rules both
preserve holes. Disconnected fill intervals use pen lifts, not stray diagonals.