import { describe, it, expect } from 'vitest';
import { searchPlayers, searchWords } from './player-search';

const chase = { name: "Ja'Marr Chase", position: 'WR', proTeam: 'CIN', owner: "Miguel's Magnificent Team" };
const stBrown = { name: 'Amon-Ra St. Brown', position: 'WR', proTeam: 'DET', owner: 'Your roster' };
const stevenson = { name: 'Rhamondre Stevenson', position: 'RB', proTeam: 'NE', owner: 'Likely to Pierce Brown People' };
const shough = { name: 'Tyler Shough', position: 'QB', proTeam: 'NO', owner: 'Waivers' };
const panthers = { name: 'Panthers D/ST', position: 'DST', proTeam: 'CAR', owner: 'Free agent' };
const wright = { name: 'Jaylen Wright', position: 'RB', proTeam: 'MIA', owner: 'Waivers' };
const kelce = { name: 'Travis Kelce', position: 'TE', proTeam: 'KC', owner: 'Your roster' };
const rows = [chase, stBrown, stevenson, shough, panthers, wright, kelce];
const find = (q: string) => searchPlayers(rows, q).map((r) => r.name);

describe('player search', () => {
  it('normalizes names the way people type them', () => {
    expect(searchWords("Ja'Marr")).toEqual(['jamarr']);
    expect(searchWords('Amon-Ra St. Brown')).toEqual(['amon', 'ra', 'st', 'brown']);
    expect(searchWords('Zé')).toEqual(['ze']);
  });

  it('matches word starts in the name, in any order and case', () => {
    expect(find('jamarr')).toEqual(["Ja'Marr Chase"]);
    expect(find("ja'marr")).toEqual(["Ja'Marr Chase"]);
    expect(find('chase ja')).toEqual(["Ja'Marr Chase"]);
    expect(find('amon-ra')).toEqual(['Amon-Ra St. Brown']);
    expect(find('SHOU')).toEqual(['Tyler Shough']);
    expect(find('hough')).toEqual([]);
  });

  it('shows only name matches when there are any, so an owner named Brown does not crowd "st brown"', () => {
    expect(find('st brown')).toEqual(['Amon-Ra St. Brown']);
  });

  it('falls back to position, NFL team, and owner, and needs every word', () => {
    expect(find('wr det')).toEqual(['Amon-Ra St. Brown']);
    expect(find('miguel wr')).toEqual(["Ja'Marr Chase"]);
    expect(find('waivers')).toEqual(['Tyler Shough', 'Jaylen Wright']);
    expect(find('free dst')).toEqual(['Panthers D/ST']);
    expect(find('miguel')).toEqual(["Ja'Marr Chase"]);
    expect(find('your')).toEqual(['Amon-Ra St. Brown', 'Travis Kelce']);
    expect(find('chase wr')).toEqual(["Ja'Marr Chase"]);
    expect(find('wr cin det')).toEqual([]);
  });

  it('reads a position code as the position, not the start of a name', () => {
    expect(find('wr')).toEqual(["Ja'Marr Chase", 'Amon-Ra St. Brown']);
    expect(find('WR')).toEqual(["Ja'Marr Chase", 'Amon-Ra St. Brown']);
    expect(find('wri')).toEqual(['Jaylen Wright']);
    expect(find('te')).toEqual(['Travis Kelce']);
    expect(find('def')).toEqual(['Panthers D/ST']);
    expect(find('rb wright')).toEqual(['Jaylen Wright']);
    expect(find('qb rb')).toEqual(['Rhamondre Stevenson', 'Tyler Shough', 'Jaylen Wright']);
  });

  it('shows everyone, in order, for an empty or punctuation-only query', () => {
    expect(find('')).toEqual(rows.map((r) => r.name));
    expect(find('  - ')).toEqual(rows.map((r) => r.name));
  });
});
