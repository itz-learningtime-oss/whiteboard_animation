# Marker Asset

`hand_marker.png` is a static, generated asset supplied with Scribble Studio under
the project's MIT License. It is not fetched or generated when the application
runs. No external AI service is required to use it or render a video.

The bundled PNG has a white matte. `setup_builder.py` converts only background-
connected near-white pixels to transparency. The renderer also performs this
conversion in memory when setup was skipped. The original reference canvas is
1024 x 1024, with a marker tip at approximately (286, 285). See `hand_marker.json`.

Input pictures and audio remain your property. Only render and redistribute media
you have permission to use. There is no automatic license grant for uploaded media.