import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isAssetMentionedInText,
  isAssetRecentlyCreated,
  parseSafeDate,
} from '../src/utils/assetMatcher.js'

describe('frontweb assetMatcher tests', () => {
  const script = `
爆炸掀起碎石，子弹贴着红狼的头盔飞过。红狼躲到断墙后换弹，蜂医倒在十几米外。
时间回到任务开始前。红狼、蜂医和露娜站在废弃工厂外围，远处的情报箱闪着微光。
露娜：“地图情报还没确认。工厂里至少有两个火力点，撤离路线也可能已经暴露。”
红狼没有回答，握着武器冲进工厂。
丽霞端着水果走到书桌旁，看见数学作业仍然空着。
奕辰紧盯屏幕，手指飞快操作。
坐在另一张书桌前的奕馨合上练习册，转头看向哥哥。
奕馨：“你刚才也说马上。可你的作业一个字都没写。”
  `.trim()

  it('matches compound scene 废弃工厂内部战斗区 against script with 废弃工厂 and 工厂', () => {
    assert.equal(isAssetMentionedInText('scene', { location: '废弃工厂内部战斗区' }, script), true)
  })

  it('matches scene 奕辰与奕馨家中双人书房·书桌区 against script with 奕辰, 奕馨 and 书桌', () => {
    assert.equal(isAssetMentionedInText('scene', { location: '奕辰与奕馨家中双人书房·书桌区' }, script), true)
  })

  it('rejects completely unmentioned scenes', () => {
    assert.equal(isAssetMentionedInText('scene', { location: '加勒比海盗船甲板' }, script), false)
  })

  it('safely parses sqlite timestamps and respects 20min grace period', () => {
    const now = Date.now()
    const fiveMinutesAgo = new Date(now - 5 * 60 * 1000).toISOString().replace('T', ' ').replace('Z', '')
    assert.equal(isAssetRecentlyCreated({ created_at: fiveMinutesAgo }, 20), true)

    const twoHoursAgo = new Date(now - 120 * 60 * 1000).toISOString()
    assert.equal(isAssetRecentlyCreated({ created_at: twoHoursAgo }, 20), false)
  })
})
