/**
 * Cookie names for display preferences, shared by the pages that read them and
 * the route that sets them. Kept free of server-only imports so the route can
 * be tested directly.
 */

/** "next" plans the week after the one being played; anything else shows this week. */
export const WEEK_COOKIE = 'ds-week';

/** "off" leaves betting odds out of projections; on by default. */
export const ODDS_COOKIE = 'ds-odds';

/** "off" leaves NFL matchups out of projections; on by default. */
export const MATCHUP_COOKIE = 'ds-matchups';

/** "off" leaves a player's own scoring this season out of projections; on by default. */
export const FORM_COOKIE = 'ds-form';
