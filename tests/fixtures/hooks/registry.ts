// A sample hook registry module loaded dynamically by loadHookRegistry in tests.

export const hooks = {
  makeUser: () => ({ id: 'fixture-user' }),
};

export const comparators = {
  alwaysPass: () => [],
};
