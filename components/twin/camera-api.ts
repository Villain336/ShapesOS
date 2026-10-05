// ShapesOS — Phase 13 (twinui): the imperative camera API the 3D canvas hands
// to the overlay controls (zoom, rotate 90°, reset, home, fly-to). Types only,
// so the server-rendered shell never pulls three.js in.

export interface TwinCameraApi {
  zoomBy: (factor: number) => void;
  /** Turn the view 90° around the site (clockwise seen from above). */
  rotate90: () => void;
  /** Default isometric angle, whole site in view. */
  reset: () => void;
  /** Whole site in view, current angle kept. */
  home: () => void;
  flyTo: (objectId: string) => void;
}
