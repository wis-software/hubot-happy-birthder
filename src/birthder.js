// Description:
//   Birthday bot.
//
// Commands:
//   begin group Happy Birthder
//    hubot birthdays list - shows a list of users and their birthdays
//    hubot birthdays on <date>.<month> - shows a list of users with a set birthday date
//    hubot fwd list - shows a list of users and their first working days
//    begin admin
//      hubot birthday set @username <date>.<month>.<year> - sets a birthday for the user
//      hubot birthday delete @username - deletes birthday for the user
//      hubot fwd set @username <date>.<month>.<year> - sets a first working day for the user
//    end admin
//   end group
//

(function () {
  const moment = require('moment')
  const routines = require('hubot-routines')
  const schedule = require('node-schedule')

  const utils = require('./utils')

  module.exports = async (robot) => {
    // Checking if the bot is in the channel specified via the BIRTHDAY_LOGGING_CHANNEL environment variable.
    const botChannels = await robot.adapter.api.get('channels.list.joined')
    const botGroups = await robot.adapter.api.get('groups.list')
    const chExists = botChannels.channels.filter(item => item.name === utils.BIRTHDAY_LOGGING_CHANNEL).length
    const grExists = botGroups.groups.filter(item => item.name === utils.BIRTHDAY_LOGGING_CHANNEL).length
    if (!chExists && !grExists) {
      routines.rave(robot, `Hubot is not in the group or channel named '${utils.BIRTHDAY_LOGGING_CHANNEL}'`)
      return
    }

    const regExpUsername = new RegExp(/(?:@?(.+))/)
    const regExpDate = new RegExp(/((\d{1,2})\.(\d{1,2})\.(\d{4}))\b/)
    const regExpShortDate = new RegExp(/((\d{1,2})\.(\d{1,2}))\b/)

    const routes = {
      set: new RegExp(/(birthday set)\s+/.source + regExpUsername.source + /\s+/.source + regExpDate.source, 'i'),
      delete: new RegExp(/(birthday delete)\s+/.source + regExpUsername.source + /\b/.source, 'i'),
      check: new RegExp(/(birthdays on)\s+/.source + regExpShortDate.source, 'i'),
      list: new RegExp(/(birthdays|fwd) list$/, 'i'),
      fwd_set: new RegExp(/(fwd set)\s+/.source + regExpUsername.source + /\s+/.source + regExpDate.source, 'i'),
      agreeToPitchIn: new RegExp(/Yes, I'll pitch in on a present for\s+/.source + regExpUsername.source, 'i'),
      disagreeToPitchIn: new RegExp(/No, I won't pitch in on a present for\s+/.source + regExpUsername.source, 'i')
    }

    if (utils.TENOR_API_KEY === '') {
      routines.rave(robot, 'TENOR_API_KEY is a mandatory parameter, however it\'s not specified.')
      return
    }

    robot.enter(msg => {
      async function sendMessageWithAttempts (user, attempt) {
        if (attempt >= 30) {
          console.log(`Error! User @${user.name} is still unavailable after 30 attempts.`)
          return
        }

        const dialogCreatingInfo = await robot.adapter.api.post(
          'im.create',
          {
            username: user.name
          }
        )

        if (!dialogCreatingInfo) {
          console.log(`User @${user.name} is unavailable. Attempt number ${attempt}. Retrying...`)
          setTimeout(
            () => sendMessageWithAttempts(user, attempt+1),
            5000
          )
          return
        }

        const chatID = dialogCreatingInfo.room._id
        await robot.adapter.api.post(
          'chat.postMessage',
          {
            roomId: chatID,
            emoji: ':wave:',
            text: `Welcome to ${utils.COMPANY_NAME}! :tada:\nEmm... where was I?\nOh! Please, enter your date birth (DD.MM.YYYY).`
          }
        )
        console.log(`User @${user.name} is welcomed by bot.`)
      }

      if (msg.message.user.roomID === 'GENERAL') {
        const brain = robot.brain.data.users
        const username = msg.message.user.name
        const user = Object.values(brain).filter(item => item.name === username).shift()
        if (!user.dateOfBirth) {
          sendMessageWithAttempts(user, 0)
        }
        const today = moment().format(utils.OUTPUT_DATE_FORMAT)
        user.dateOfFwd = today
      }
    })

    robot.respond(/(Hi. I got a job (.*))\s*/i, msg => {
      const user = msg.message.user

      if (typeof user.position !== 'boolean') {
        msg.send('I already know that you works with us :wink:')

        return
      }

      const messageText = `Are you sure you're an ${msg.match[2]}?`
      const options = [
        ['Yes', `Yes. I am definitely ${msg.match[2]}`],
        ['No', 'No. I have incorrectly indicated my position']
      ]
      msg.send(routines.buildMessageWithButtons(messageText, options))
    })

    robot.respond(/(Yes. I am definitely (.*)|(No. I have incorrectly indicated my position))/i, msg => {
      const user = msg.message.user

      if (typeof user.position !== 'boolean') {
        msg.send('I already know that you works with us :wink:')

        return
      }

      if (msg.match[1].toLowerCase() === 'no. i have incorrectly indicated my position') {
        const messageText = 'So. Who are you?,'
        const options = utils.EMPLOYEE_OCCUPATION
          .split(',')
          .map(item => [item, `Hi. I got a job ${item}`])

        const message = routines.buildMessageWithButtons(messageText, options)

        msg.send(message)

        return
      }

      msg.send('Ok. Thank you for your time')
      const position = msg.match[2].toLowerCase()
      const message = `Let's welcome our new ${position} - @${user.name} :tada:`

      robot.messageRoom('general', message)

      user.position = position
    })

    robot.respond(regExpDate, msg => {
      const username = msg.message.user.name
      const user = robot.brain.userForName(username)
      const date = msg.match[1]

      if (!user.dateOfBirth) {
        if (routines.isValidDate(date, utils.DATE_FORMAT)) {
          user.dateOfBirth = date
          msg.send('I memorized you birthday, well done! :wink:')
          robot.messageRoom(utils.BIRTHDAY_LOGGING_CHANNEL, `All right, @${user.name}'s birthday was specified!`)
          // Next step is send check to new employee
          if (utils.EMPLOYEE_OCCUPATION) {
            const messageText = 'What is your position?'
            const options = utils.EMPLOYEE_OCCUPATION
              .split(',')
              .map(item => [item, `Hi. I got a job ${item}`])
            const message = routines.buildMessageWithButtons(messageText, options)
            robot.adapter.sendDirect({ user: { name: user.name } }, message)
            user.position = false
          }
        } else {
          msg.send(utils.MSG_INVALID_DATE)
        }
      }
    })

    // Link together the specified birthday and user and store the link in the brain.
    robot.respond(routes.set, async (msg) => {
      let date
      let name
      let user
      let users

      if (!await routines.isAdmin(robot, msg.message.user.name.toString())) {
        msg.send(utils.MSG_PERMISSION_DENIED)
        return
      }

      name = msg.match[2].trim()
      date = msg.match[3]
      users = []

      for (const u of robot.brain.usersForFuzzyName(name)) {
        if (await routines.isUserActive(robot, u)) {
          users.push(u)
        }
      }

      if (!routines.isValidDate(date, utils.DATE_FORMAT)) {
        msg.send(utils.MSG_INVALID_DATE)
        return
      }

      if (users.length === 1) {
        user = users[0]
        user.dateOfBirth = date

        return msg.send(`Saving ${name}'s birthday.`)
      } else if (users.length > 1) {
        return msg.send(utils.getAmbiguousUserText(users))
      } else {
        return msg.send(`I have never met ${name}.`)
      }
    })

    // Print the users names whose birthdays match the specified date.
    robot.respond(routes.check, async (msg) => {
      let date
      let message
      let users = []
      let userNames

      date = msg.match[2]

      for (const u of utils.findUsersByDate(utils.BDAY_EVENT_TYPE, moment(date, utils.SHORT_DATE_FORMAT), robot.brain.data.users)) {
        if (await routines.isUserActive(robot, u)) {
          users.push(u)
        }
      }

      if (users.length === 0) {
        return msg.send('Could not find any user with the specified birthday.')
      }

      userNames = users.map(user => `@${user.name}`)
      message = `${userNames.join(', ')}`

      return msg.send(message)
    })

    // Delete the birthday associated with the specified user name.
    robot.respond(routes.delete, async (msg) => {
      let name = msg.match[2].trim()
      let user
      let users = []

      if (!await routines.isAdmin(robot, msg.message.user.name.toString())) {
        msg.send(utils.MSG_PERMISSION_DENIED)
        return
      }

      for (const u of robot.brain.usersForFuzzyName(name)) {
        if (await routines.isUserActive(robot, u)) {
          users.push(u)
        }
      }

      if (users.length === 1) {
        user = users[0]
        if (!user.dateOfBirth) {
          return msg.send('A birth date is not specified for the user.')
        }

        user.dateOfBirth = null

        return msg.send(`Removing ${name}'s birthday.`)
      } else if (users.length > 1) {
        return msg.send(utils.getAmbiguousUserText(users))
      } else {
        return msg.send(`I have never met ${name}.`)
      }
    })

    // Print sorted users birthdays and first working days.
    robot.respond(routes.list, async (msg) => {
      let attr, desc, title

      const getSortedDate = (date) => {
        if (attr === 'dateOfBirth') {
          const thisYear = moment().year()
          const newDate = moment(date, utils.DATE_FORMAT).year(thisYear)

          return newDate.unix() >= moment().unix()
            ? newDate.format(`DD.MM.${newDate.year() - 1}`) : newDate.format(`DD.MM.${newDate.year()}`)
        }

        if (attr === 'dateOfFwd') {
          return date
        }
      }

      if (msg.match[1] === 'birthdays') {
        attr = 'dateOfBirth'
        desc = `was born on`
        title = `Birthdays`
      }
      if (msg.match[1] === 'fwd') {
        attr = 'dateOfFwd'
        desc = `joined our team`
        title = `First working days`
      }

      let message

      const allUsers = []
      for (const u of Object.values(robot.brain.data.users)) {
        if (await routines.isUserActive(robot, u)) {
          allUsers.push(u)
        }
      }

      message = allUsers
        .filter(user => routines.isValidDate(user[attr], utils.DATE_FORMAT))
        .map(user => {
          const sortedDate = getSortedDate(user[attr])

          return {
            name: user.name,
            [attr]: user[attr],
            sortedDate: sortedDate
          }
        })
        .sort((a, b) => utils.sorting(a.sortedDate, b.sortedDate, 'DD.MM.YYYY'))
        .map(user => ` @${user.name} ${desc} ${moment(user[attr], utils.DATE_FORMAT).format(utils.OUTPUT_DATE_FORMAT)}`)

      if (!message.length) {
        msg.send('Oops... No results.')
        return
      }

      msg.send(`*${title} list*\n${message.join('\n')}`)
    })

    robot.respond(routes.agreeToPitchIn, async msg => {
      const targetUsername = msg.match[1]
      const bdayUser = await routines.findUserByName(robot, targetUsername)

      if (!bdayUser) {
        msg.send(`I have never met ${targetUsername}.`)

        return
      }

      if (!bdayUser.birthdayChannel) {
        msg.send('This person does not plan to celebrate their birthday in the nearest future. Do not rush.')

        return
      }

      bdayUser.birthdayPitchingInList = bdayUser.birthdayPitchingInList || []

      if (bdayUser.birthdayPitchingInList.includes(msg.message.user.id)) {
        msg.send('You have already told me that you would.')
      } else {
        bdayUser.birthdayPitchingInList.push(msg.message.user.id)

        msg.send('Fine! We count on you.')
      }
    })

    robot.respond(routes.disagreeToPitchIn, async msg => {
      const targetUsername = msg.match[1]
      const bdayUser = await routines.findUserByName(robot, targetUsername)

      if (!bdayUser) {
        msg.send(`I have never met ${targetUsername}.`)

        return
      }

      if (!bdayUser.birthdayChannel) {
        msg.send('This person does not plan to celebrate their birthday in the nearest future. Do not rush.')

        return
      }

      bdayUser.birthdayPitchingInList = bdayUser.birthdayPitchingInList || []

      if (bdayUser.birthdayPitchingInList.includes(msg.message.user.id)) {
        bdayUser.birthdayPitchingInList = bdayUser.birthdayPitchingInList.filter(
          userId => userId !== msg.message.user.id
        )

        msg.send('It\'s a shame. I will remove you from the pitching in list.')
      } else {
        msg.send('Ok, I understand.')
      }
    })

    // Reset date of first working day.
    robot.respond(routes.fwd_set, async (msg) => {
      let date
      let name
      let user
      let users

      if (!await routines.isAdmin(robot, msg.message.user.name.toString())) {
        msg.send(utils.MSG_PERMISSION_DENIED)
        return
      }

      name = msg.match[2].trim()
      date = msg.match[3]
      users = []

      for (const u of robot.brain.usersForFuzzyName(name)) {
        if (await routines.isUserActive(robot, u)) {
          users.push(u)
        }
      }

      if (!routines.isValidDate(date, utils.DATE_FORMAT)) {
        msg.send(utils.MSG_INVALID_DATE)
        return
      }

      if (users.length === 1) {
        user = users[0]
        user.dateOfFwd = date

        return msg.send(`Saving ${name}'s first working day.`)
      } else if (users.length > 1) {
        return msg.send(utils.getAmbiguousUserText(users))
      } else {
        return msg.send(`I have never met ${name}.`)
      }
    })

    // Check regularly if today is someone's birthday, write birthday messages to the general channel.
    if (utils.HAPPY_REMINDER_SCHEDULER) {
      schedule.scheduleJob(utils.HAPPY_REMINDER_SCHEDULER, () => utils.sendCongratulations(robot, utils.BDAY_EVENT_TYPE))
    }

    // Check regularly if today is someone's anniversary day, write congratulation message to the general channel.
    if (utils.HAPPY_REMINDER_SCHEDULER) {
      schedule.scheduleJob(utils.HAPPY_REMINDER_SCHEDULER, () => utils.sendCongratulations(robot, utils.FWD_EVENT_TYPE))
    }

    // test

    // Send reminders of the upcoming birthdays to the users (except ones whose birthday it is).

    if (utils.HAPPY_REMINDER_SCHEDULER) {
      schedule.scheduleJob(utils.HAPPY_REMINDER_SCHEDULER, () => utils.sendReminders(robot, utils.NUMBER_OF_DAYS_IN_ADVANCE, 'days'))
    }

    if (utils.HAPPY_REMINDER_SCHEDULER) {
      schedule.scheduleJob(utils.HAPPY_REMINDER_SCHEDULER, () => utils.sendReminders(robot, 1, 'day'))
    }

    if (utils.HAPPY_REMINDER_SCHEDULER) {
      schedule.scheduleJob(utils.HAPPY_REMINDER_SCHEDULER, () => utils.removeExpiredBirthdayChannels(robot))
    }

    if (utils.HAPPY_REMINDER_SCHEDULER) {
      schedule.scheduleJob(utils.HAPPY_REMINDER_SCHEDULER, () => utils.detectBirthdaylessUsers(robot))
    }

    if (utils.HAPPY_REMINDER_SCHEDULER) {
      schedule.scheduleJob(utils.HAPPY_REMINDER_SCHEDULER, () => utils.sendReminderOfBegging(robot))
    }
  }
}).call(this)
