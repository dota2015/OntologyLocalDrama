export function referenceImageMode(resource) {
  return resource?.reference_image_mode === 'quad_grid' ? 'quad_grid' : 'single'
}
export function usesFourViews(resource) { return referenceImageMode(resource) === 'quad_grid' }
