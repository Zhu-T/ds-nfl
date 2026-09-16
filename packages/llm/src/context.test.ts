import { describe, it, expect } from 'vitest';
import { leagueContext, type LeagueContextInput } from './context.js';
import { checkNumbers } from './guard.js';

const input: LeagueContextInput = {
  teamName: "Tony's Personal Computer",
  lineupFacts: "League: 2026 Tommy's League (12-team · 0.5 PPR), week 1.",
  roster: [
    { name: 'Deebo Samuel Sr.', position: 'WR', slot: 'BENCH', projected: 7.4, proTeam: 'WSH' },
    { name: 'Matthew Stafford', position: 'QB', slot: 'QB', projected: 19.6, proTeam: 'LAR', note: 'locked' },
    { name: 'Kyle Pitts Sr.', position: 'TE', slot: 'TE', projected: 7.6, proTeam: 'ATL', note: 'Questionable' },
  ],
  waivers: [{ name: 'Titans D/ST', position: 'DST', projected: 6.8, gain: 0.7, pickup: 'waivers' }],
  trades: [{ give: 'Trevor Lawrence', get: 'Tee Higgins', opponent: 'Ceebee', myGain: 2.5, theirGain: 0.3 }],
  news: [
    {
      player: 'Michael Wilson',
      published: '2026-09-14',
      headline: 'Wilson secured five of seven targets for 56 yards.',
      story: 'He ran second in routes.',
    },
  ],
};

describe('leagueContext', () => {
  const { sections, text } = leagueContext(input);

  it('has the five sections, in order', () => {
    expect(sections.map((s) => s.title)).toEqual([
      'This week',
      'Your roster',
      'Waiver wire',
      'Trade ideas',
      'Recent news',
    ]);
  });

  it('lists starters before the bench, with notes', () => {
    const roster = sections[1]!.body.split('\n');
    expect(roster[0]).toBe('- QB: Matthew Stafford (QB, LAR), projected 19.6; locked');
    expect(roster[1]).toBe('- TE: Kyle Pitts Sr. (TE, ATL), projected 7.6; Questionable');
    expect(roster[2]).toBe('- Bench: Deebo Samuel Sr. (WR, WSH), projected 7.4');
  });

  it('says how a pickup can be made and what each trade is worth to both sides', () => {
    expect(text).toContain('- Titans D/ST (DST): projected 6.8, adds 0.7; needs a waiver claim');
    expect(text).toContain('- Give Trevor Lawrence, get Tee Higgins from Ceebee: your best lineup gains 2.5, theirs gains 0.3.');
  });

  it('says pickups and trades are valued apart from this week’s locks', () => {
    expect(sections[2]!.body).toContain('valued as if no game had kicked off');
    expect(sections[3]!.body).toContain('as if no game had kicked off');
  });

  it('includes dated news with its story', () => {
    expect(text).toContain('- Michael Wilson (2026-09-14): Wilson secured five of seven targets for 56 yards. He ran second in routes.');
  });

  it('states empty sections plainly instead of leaving them blank', () => {
    const empty = leagueContext({ ...input, roster: [], waivers: [], trades: [], news: [] }).text;
    expect(empty).toContain('No players on the roster.');
    expect(empty).toContain('No available player improves your best possible lineup.');
    expect(empty).toContain('No one-for-one trade improves both starting lineups.');
    expect(empty).toContain('No news in the last 7 days for your players.');
  });

  it('titles the first section with the week when given, and adds web news when checked', () => {
    const planned = leagueContext({
      ...input,
      weekLabel: 'Week 2 (next week, not started)',
      webNews: {
        checkedAt: '2026-09-17',
        by: 'deepseek-r1:14b read the news gathered from ESPN and Google News',
        findings: [
          { player: 'Kyle Pitts Sr.', status: 'questionable', factor: 0.8, summary: 'Limited Thursday.', sources: ['https://espn.com/p'] },
          { player: 'Deebo Samuel Sr.', status: 'out', factor: 0, summary: 'Ruled out Friday.', sources: ['https://nfl.com/d'] },
        ],
      },
    });
    expect(planned.sections[0]!.title).toBe('Week 2 (next week, not started)');
    expect(planned.sections.at(-1)!.title).toBe('News check');
    expect(planned.text).toContain('deepseek-r1:14b read the news gathered from ESPN and Google News on 2026-09-17.');
    expect(planned.text).toContain('- Kyle Pitts Sr.: questionable, projection multiplied by 0.8. Limited Thursday. Sources: https://espn.com/p');
    expect(planned.text).toContain('- Deebo Samuel Sr.: ruled out. Ruled out Friday. Sources: https://nfl.com/d');
    expect(leagueContext({ ...input, webNews: { checkedAt: '2026-09-17', by: 'Claude searched the web', findings: [] } }).text).toContain(
      "found nothing that changes these players' outlook",
    );
  });

  it('lists available players by position, best projected first, only when given', () => {
    const withPool = leagueContext({
      ...input,
      available: [
        { name: 'Chris Brooks', position: 'RB', proTeam: 'GB', projected: 4.1, pickup: 'waivers', gain: 0 },
        { name: 'Tyler Shough', position: 'QB', proTeam: 'NO', projected: 16.6, pickup: 'waivers', gain: 0, note: 'recommended in waiver articles' },
        { name: 'Jaylen Wright', position: 'RB', proTeam: 'MIA', projected: 6.2, pickup: 'free-agent', gain: 1.3, note: 'Questionable' },
      ],
    });
    expect(withPool.sections.map((s) => s.title)).toEqual([
      'This week',
      'Your roster',
      'Waiver wire',
      'Available players',
      'Trade ideas',
      'Recent news',
    ]);
    expect(withPool.sections[3]!.body.split('\n').slice(1)).toEqual([
      '- Tyler Shough (QB, NO): projected 16.6, adds 0.0; needs a waiver claim; recommended in waiver articles',
      '- Jaylen Wright (RB, MIA): projected 6.2, adds 1.3; free agent, can be added now; Questionable',
      '- Chris Brooks (RB, GB): projected 4.1, adds 0.0; needs a waiver claim',
    ]);
    expect(checkNumbers('Shough projects 16.6 and Wright would add 1.3.', withPool.text).ok).toBe(true);
  });

  it('keeps each position to a short list', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      name: `Receiver ${i}`,
      position: 'WR',
      proTeam: null,
      projected: 12 - i,
      pickup: 'free-agent' as const,
      gain: 0,
    }));
    const body = leagueContext({ ...input, available: many }).sections[3]!.body;
    expect(body.split('\n').slice(1)).toHaveLength(8);
    expect(body).toContain('- Receiver 0 (WR): projected 12.0');
    expect(body).not.toContain('Receiver 8 ');
    expect(leagueContext({ ...input, available: [] }).sections[3]!.body).toBe('No unrostered players were loaded.');
  });

  it('lets an answer quote the context, news figures included, and rejects anything else', () => {
    expect(checkNumbers('Titans D/ST adds 0.7, and Wilson had 56 yards.', text).ok).toBe(true);
    expect(checkNumbers('Titans D/ST adds 1.5 points.', text).invented).toEqual([1.5]);
  });
});
