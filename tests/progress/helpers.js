'use strict';

const ACTOR_A = '00000000-0000-4000-8000-000000000001';
const ACTOR_B = '00000000-0000-4000-8000-000000000002';
const PROFILE_A = '10000000-0000-4000-8000-000000000001';
const PROFILE_B = '10000000-0000-4000-8000-000000000002';

function makeState({ actor = ACTOR_A, clock = 1, profileId = PROFILE_A, found = {}, name = 'Main', region = '', enabledTypes = ['o5'], hideFound = false } = {}) {
  const register = value => ({ value, clock, actor });
  return {
    namespace: 'appsample:gim:2',
    profiles: {
      [profileId]: {
        name: register(name), region: register(region),
        enabledTypes: register([...enabledTypes]), hideFound: register(hideFound),
        markers: Object.fromEntries(Object.entries(found).map(([id, value]) => [id, register(value)])),
      },
    },
  };
}

module.exports = { ACTOR_A, ACTOR_B, PROFILE_A, PROFILE_B, makeState };
