import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const origin='https://huarong-dao.spacexpanseorg.workers.dev/';
const asset=name=>readFileSync(new URL('../public/'+name,import.meta.url));
const html=asset('index.html').toString('utf8');
const head=html.match(/<head>([\s\S]*?)<\/head>/)[1];

/** Read static quoted attributes without counting strings inside executable scripts. */
function tags(name){
  const markup=head.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<!--[\s\S]*?-->/g,'');
  return [...markup.matchAll(new RegExp('<'+name+'\\b[^>]*>','g'))].map(([tag])=>
    Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([,key,value])=>[key,value])));
}
const metadata=tags('meta');
/** Require one and only one tag per metadata key. */
function meta(key){
  const matches=metadata.filter(tag=>(tag.name||tag.property)===key);
  assert.equal(matches.length,1,key+' must be unique');
  assert.ok(matches[0].content,key+' must have content');
  return matches[0].content;
}

/** Validate PNG header, chunk boundaries and decompressed raster without an image dependency. */
function pngSize(name){
  const bytes=asset(name);
  assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal(bytes.toString('ascii',12,16),'IHDR');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  assert.equal(bytes[24],8); // Original assets are non-interlaced 8-bit RGB.
  assert.equal(bytes[25],2);
  assert.equal(bytes[28],0);
  const chunks=[];
  let offset=8,ended=false;
  while(offset<bytes.length){
    const length=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8);
    assert.ok(offset+12+length<=bytes.length,'complete PNG chunk');
    if(type==='IDAT')chunks.push(bytes.subarray(offset+8,offset+8+length));
    offset+=12+length;
    if(type==='IEND'){ended=true;break;}
  }
  assert.ok(ended);
  assert.equal(offset,bytes.length);
  assert.equal(inflateSync(Buffer.concat(chunks)).length,(1+width*3)*height);
  return [width,height];
}

test('static Bulgarian metadata is unique, useful and canonical at the actual root',()=>{
  const titles=[...head.matchAll(/<title>([^<]+)<\/title>/g)];
  assert.equal(titles.length,1);
  assert.equal(titles[0][1],'Хуаронг Дао (Klotski) — играй онлайн с подсказки и класация');
  assert.match(html,/<html lang="bg"/);
  assert.equal(meta('description'),'Играй Хуаронг Дао (Klotski) онлайн с 14 подредби. Учи с оптимални подсказки за всяка подредба, после решавай без помощ за седмичната класация.');
  const canonical=tags('link').filter(tag=>tag.rel==='canonical');
  assert.equal(canonical.length,1);
  assert.equal(canonical[0].href,origin);
  assert.equal(tags('link').filter(tag=>tag.hreflang).length,0);
  assert.equal(meta('og:url'),origin);
  assert.equal(meta('og:type'),'website');
  assert.equal(meta('og:site_name'),'Huarong Dao');
  assert.equal(meta('og:locale'),'bg_BG');
  assert.equal(meta('og:locale:alternate'),'en_US');
  for(const tag of metadata.filter(tag=>tag.name||tag.property))meta(tag.name||tag.property);
});

test('social cards share distinct challenge copy, accessible alt and existing absolute image',()=>{
  const title=head.match(/<title>([^<]+)<\/title>/)[1];
  for(const prefix of ['og','twitter']){
    assert.equal(meta(prefix+':title'),'Освободи червения блок. Намери по-краткия път.');
    assert.equal(meta(prefix+':description'),'Хуаронг Дао (Klotski): 14 подредби и оптимални подсказки, когато се затрудниш. Решавай без помощ за седмичната класация.');
    assert.notEqual(meta(prefix+':title'),title);
    assert.notEqual(meta(prefix+':description'),meta('description'));
    assert.equal(meta(prefix+':image'),origin+'social-preview.png');
    assert.equal(meta(prefix+':image:alt'),'Huarong Dao / Klotski. Дъската от Тренировка. Английски надписи: AI обучение и оптимални подсказки за всяка подредба; седмично публично състезание с трайни публични резултати в блокчейна, които могат да се възстановят независимо; архив на самоличността за изтегляне.');
  }
  assert.equal(meta('twitter:card'),'summary_large_image');
  assert.equal(meta('og:image:type'),'image/png');
  assert.deepEqual(pngSize('social-preview.png'),[1200,630]);
  assert.equal(meta('og:image:width'),'1200');
  assert.equal(meta('og:image:height'),'630');
  const icons=tags('link').filter(tag=>tag.rel==='icon');
  assert.deepEqual(icons,[{rel:'icon',type:'image/png',sizes:'32x32',href:'/favicon.png'}]);
  assert.deepEqual(pngSize('favicon.png'),[32,32]);
});

test('structured data is parseable and limited to factual bilingual game properties',()=>{
  const blocks=[...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length,1);
  const game=JSON.parse(blocks[0][1]);
  assert.deepEqual(Object.keys(game).sort(),['@context','@type','name','alternateName','url','image','description','genre','applicationCategory','operatingSystem','inLanguage'].sort());
  assert.equal(game['@context'],'https://schema.org');
  assert.deepEqual(game['@type'],['VideoGame','WebApplication']);
  assert.equal(game.name,'Huarong Dao');
  assert.equal(game.alternateName,'Хуаронг Дао');
  assert.equal(game.url,origin);
  assert.equal(game.image,meta('og:image'));
  assert.equal(game.genre,'Puzzle');
  assert.equal(game.applicationCategory,'GameApplication');
  assert.equal(game.operatingSystem,'Web browser');
  assert.deepEqual(game.inLanguage,['bg','en']);
  assert.equal(game.description,'Хуаронг Дао (Klotski) е браузърен пъзел с плъзгащи се блокове, 14 подредби, оптимални подсказки и автоматично проиграване на решенията. Нови неподпомогнати състезателни игри могат да участват в седмичната и общата класация. Публичното публикуване е по избор. Потвърдените записи на ходовете в ROD могат независимо да се проиграят и проверят; локалните резултати не се синхронизират автоматично.');
});

test('robots allows rendering and advertises only the canonical sitemap',()=>{
  const lines=asset('robots.txt').toString('utf8').trim().split(/\r?\n/).filter(Boolean);
  assert.deepEqual(lines,['User-agent: *','Allow: /','Disallow: /api/','Disallow: /probe','Sitemap: '+origin+'sitemap.xml']);
  for(const file of ['index.html','leaderboard-ui.js','ranked-session.js','leaderboard-client.js','social-preview.png','favicon.png']){
    assert.ok(asset(file).length);
    assert.ok(!lines.some(line=>line==='Disallow: /'+file));
  }
});

test('sitemap is a single well-formed canonical URL without invented dates or alternates',()=>{
  const sitemap=asset('sitemap.xml').toString('utf8');
  // This tiny fixed grammar rejects unmatched elements, attributes and extra URLs.
  const parsed=sitemap.match(/^<\?xml version="1\.0" encoding="UTF-8"\?>\s*<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">\s*<url>\s*<loc>([^<>&]+)<\/loc>\s*<\/url>\s*<\/urlset>\s*$/);
  assert.ok(parsed,'valid minimal sitemap XML');
  assert.equal(parsed[1],origin);
});

test('short challenge invitation exists in static main content with matching English copy',()=>{
  const main=html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)[1];
  const explanation=main.match(/<p id="game-explanation">([^<]+)<\/p>/)[1];
  assert.equal(explanation,'Хуаронг Дао (Klotski): можеш ли да изведеш червения блок през изхода долу по средата? Плъзгай фигурите. Започни с Тренировка.');
  const english='Huarong Dao (Klotski): can you free the red block through the bottom-center exit? Slide the pieces. Start with Training.';
  assert.ok(html.includes("'"+explanation+"':'"+english+"'"));
  assert.ok(explanation.length<=140 && english.length<=140,'keep the existing fixed-viewport invitation succinct');
});

test('English acquisition copy prioritizes online play, learning and unaided weekly competition',()=>{
  const english=html.match(/en:\{title:'([^']+)',\s*description:'([^']+)'/);
  assert.ok(english);
  assert.equal(english[1],'Klotski (Huarong Dao) — Play Online, Hints & Weekly Rankings');
  assert.equal(english[2],'Play Klotski (Huarong Dao) online with 14 layouts. Learn with optimal hints for every layout, then solve unaided to compete on the weekly leaderboard.');
  assert.ok(html.includes("socialTitle:'Free the red block. Find fewer moves.',socialDescription:'Huarong Dao (Klotski): 14 layouts and optimal hints when you get stuck. Solve unaided to compete on the weekly leaderboard.'"));
  assert.doesNotMatch(english[2],/identity backup|chain-reconstructable/);
  assert.ok(html.includes('persistent public results, on-chain and independently reconstructable; exportable identity backup.'));
  assert.ok(!html.includes('portable results through identity backup'));
  assert.equal((html.match(/grid-template-rows: auto auto minmax\(0,1fr\);/g)||[]).length,2);
  assert.ok(html.includes('#game-explanation { margin:0; padding:0 .25rem; color:var(--color-slate-300); font-size:.75rem; line-height:1.35; }'));
  const description=JSON.parse(head.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]).description;
  assert.match(description,/Нови неподпомогнати.*седмичната и общата класация.*по избор.*записи на ходовете в ROD.*независимо.*не се синхронизират автоматично/);
  assert.doesNotMatch(description,/самоличността|възстанови.*класация|време/);
});
