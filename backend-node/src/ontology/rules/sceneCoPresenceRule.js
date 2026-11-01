/**
 * 影视视听本体门禁：场景全员在场与防突兀降临审查（Scene Co-Presence & Anti-Apparition Rule）
 * 践行电影场面调度法则：
 * 同一场景内设定在场的人物具有空间恒常性，绝不能前几镜只画单人空房间，等到某人说话时突然凭空刷出。
 */
const BaseInvariantRule = require('./baseRule');
const { parseCharacterIds } = require('./visualSlotCompletenessRule');

const ENTRANCE_ACTION_REGEX = /(?:推门|进门|走入|进入|迈入|步入|冲进|跨入|来到|走来|现身|入画|出现在门口|刚进|推开门|从外走入|由外进入|闯入|推开)/i;

class SceneCoPresenceRule extends BaseInvariantRule {
  constructor() {
    super({
      id: 'RULE_SCENE_CO_PRESENCE',
      name: '场景全员在场与防突兀降临',
      category: 'presence',
      defaultSeverity: 'warning',
      description: '审查同一场景内角色是否恒常在场，防止无预先交代或无入场动作直接突然降临',
    });
  }

  evaluate(context) {
    const shots = context.shots;
    const violations = [];
    if (!Array.isArray(shots) || shots.length === 0) return violations;

    // 按场景分组检查
    const sceneShotsMap = new Map();
    shots.forEach((shot, idx) => {
      const scId = shot.scene_id != null ? String(shot.scene_id) : 'default_scene';
      if (!sceneShotsMap.has(scId)) sceneShotsMap.set(scId, []);
      sceneShotsMap.get(scId).push({ shot, index: idx });
    });

    sceneShotsMap.forEach((sceneItems) => {
      // 记录本场景迄今为止已出现的角色（包括主体与背景角色）
      const presentCharacters = new Set();

      sceneItems.forEach(({ shot, index }, posInScene) => {
        const shotNum = shot.shot_number || (index + 1);
        const focalIds = parseCharacterIds(shot.characters || shot.character_ids);

        // 收集本镜中的背景在场角色
        let bgIds = [];
        if (Array.isArray(shot.background_characters)) {
          bgIds = parseCharacterIds(shot.background_characters.map((b) => (b.character_id != null ? b.character_id : b.id)));
        }

        // 收集 character_visuals 中的所有角色 ID
        let visualIds = [];
        if (Array.isArray(shot.character_visuals)) {
          visualIds = parseCharacterIds(shot.character_visuals.map((v) => (v.character_id != null ? v.character_id : v.id)));
        }

        // 检查本镜头是否有台词发言人
        const dialogue = String(shot.dialogue || '').trim();
        let speakerName = '';
        if (dialogue) {
          const m = dialogue.match(/^([^:：\s]+)\s*[:：]/);
          if (m) speakerName = m[1].trim();
        }

        // 如果是该场景的第2个及以后的镜头，检查是否有角色“突然发话”或成为焦点，但在前序镜头从未出现且无入场动作
        if (posInScene > 0 && focalIds.length > 0) {
          focalIds.forEach((cid) => {
            const strId = String(cid);
            if (!presentCharacters.has(strId)) {
              // 检查本镜是否有入场动作描写
              const actionText = `${shot.action || ''} ${shot.description || ''} ${shot.start_framing || ''}`;
              const hasEntrance = ENTRANCE_ACTION_REGEX.test(actionText);

              if (!hasEntrance) {
                // 寻找角色名称
                let charName = speakerName || `角色ID:${cid}`;
                if (Array.isArray(shot.character_visuals)) {
                  const v = shot.character_visuals.find((x) => String(x.character_id) === strId);
                  if (v?.name) charName = v.name;
                }

                violations.push({
                  rule: 'INVARIANT_SUDDEN_APPARITION',
                  shot_number: shotNum,
                  severity: this.defaultSeverity,
                  message: `分镜 ${shotNum} 中角色「${charName}」成为焦点主体/发话，但在同一场景此前的镜头中从未在场，且本镜头无入场动作（如推门/走入）。此举会导致角色凭空突然降临、空间视觉断裂脱节。必须在场景前序镜头的景深背景（background_characters）中交代其在场，或在本镜头增加明确的入场动作！`,
                });
              }
            }
          });
        }

        // 更新本场景中已在场的角色库
        focalIds.forEach((id) => presentCharacters.add(String(id)));
        bgIds.forEach((id) => presentCharacters.add(String(id)));
        visualIds.forEach((id) => presentCharacters.add(String(id)));
      });
    });

    return violations;
  }
}

module.exports = SceneCoPresenceRule;
