const sceneService = require('./sceneService');
const referenceModes = require('./referenceImageModeService');

async function generateReferenceImage(db, log, cfg, sceneId, options) {
  const scene = sceneService.getSceneById(db, sceneId);
  if (!scene) return { ok: false, error: 'scene not found' };
  let useQuadGrid;
  try {
    useQuadGrid = referenceModes.generationMode(scene, options.use_quad_grid) === 'quad_grid';
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const generate = useQuadGrid ? sceneService.generateSceneFourViewImage : sceneService.generateSceneSingleImage;
  const result = await generate(db, log, cfg, sceneId, options.model, options.style);
  return { ...result, useQuadGrid };
}

module.exports = { generateReferenceImage };
