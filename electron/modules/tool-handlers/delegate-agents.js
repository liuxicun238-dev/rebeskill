const { executeDelegate } = require('../agent-team-runtime')

const handlers = {
  delegate_agents: executeDelegate
}

module.exports = { handlers }
