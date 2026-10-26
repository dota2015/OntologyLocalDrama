const response=require('../response');
const wardrobe=require('../services/wardrobeService');
const narrative=require('../services/narrativeStyleService');
module.exports=function register(r,db) {
  const handle=fn=>(req,res)=>{try{response.success(res,fn(req));}catch(err){response.badRequest(res,err.message);}};
  r.get('/settings/narrative-styles',handle(()=>narrative.PRESETS));
  r.get('/dramas/:drama_id/wardrobe/characters/:character_id',handle(req=>wardrobe.getCharacter(db,req.params.drama_id,req.params.character_id)));
  r.put('/dramas/:drama_id/wardrobe/characters/:character_id',handle(req=>wardrobe.saveCharacter(db,req.params.drama_id,req.params.character_id,req.body || {})));
  r.get('/storyboards/:id/speech-delivery',handle(req=>require('../services/speechDeliveryService').getShot(db,req.params.id)));
  r.get('/storyboards/:id/wardrobe',handle(req=>wardrobe.getShot(db,req.params.id)));
  r.put('/storyboards/:id/wardrobe',handle(req=>wardrobe.saveShot(db,req.params.id,{...req.body,source:'manual'})));
};
