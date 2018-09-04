const {
  BaseKonnector,
  requestFactory,
  signin,
  saveBills,
  log
} = require('cozy-konnector-libs')

process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://56c58c44aec84354b340322da288e886:a73efbf1f254487e9b9d5c6f2dac9a83@sentry.cozycloud.cc/60'

const moment = require('moment')
const request = requestFactory({
  // the debug mode shows all the details about http request and responses. Very usefull for
  // debugging but very verbose. That is why it is commented out by default
  // debug: true,
  // activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: true,
  // If cheerio is activated do not forget to deactivate json parsing (which is activated by
  // default in cozy-konnector-libs
  json: false,
  // this allows request-promise to keep cookies between requests
  jar: true
})

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')
  log('info', 'Getting the session id')
  const $compte = await request('https://moncompte.mediapart.fr/')
  const session = $compte('iframe[src*=moncompte]')
    .first()
    .attr('src')
    .match(/sess=([^&]*)/)[1]
  log('info', 'Fetching the list of documents')
  const $list = await request(
    `https://moncompte.mediapart.fr/base/moncompte/ajax/index.php?abonnement=0&sess=${session}`
  )
  log('info', 'Parsing list of documents')
  const documents = await parseDocuments($list)
  log('debug', documents, 'docs')
  log('info', 'Saving data to Cozy')
  await saveBills(documents, fields.folderPath, {
    keys: ['vendor', 'billId'], // deduplication keys
    identifiers: ['mediapart'] // bank operations
  })
}

// this shows authentication using the [signin function](https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#module_signin)
// even if this in another domain here, but it works as an example
function authenticate(name, password) {
  return signin({
    url: 'https://www.mediapart.fr/',
    formSelector: '#logFormEl',
    formData: { name, password },
    // the validate function will check if
    validate: (statusCode, $) => {
      // The login in toscrape.com always works excepted when no password is set
      if ($(`a[href='/logout']`).length === 2) {
        return true
      } else {
        // cozy-konnector-libs has its own logging function which format these logs with colors in
        // standalone and dev mode and as JSON in production mode
        log('error', $('.js-flash-message .error').text())
        return false
      }
    }
  })
}

// The goal of this function is to parse a html page wrapped by a cheerio instance
// and return an array of js objects which will be saved to the cozy by saveBills (https://github.com/cozy/cozy-konnector-libs/blob/master/docs/api.md#savebills)
function parseDocuments($) {
  // Common constantes
  const vendor = 'Mediapart'
  const date = new Date()
  const version = 1
  const metadata = { date, version }

  const listOfRecents = $('table li')
    .map(function(idx, li) {
      const re = /.*(\d\d\/\d\d\/\d\d\d\d).*(\d\d\/\d\d\/\d\d\d\d).*(\d+,\d\d)\s+(\S+).*/
      const [, start, end, price, currency] = $(li)
        .text()
        .match(re)
      const oStart = moment.utc(start, 'DD/MM/YYYY')
      const oEnd = moment.utc(end, 'DD/MM/YYYY')
      const startDate = oStart.format('YYYY-MM-DD')
      const endDate = oEnd.format('YYYY-MM-DD')
      const date = oEnd.toDate()
      const href = $('a', li)
        .first()
        .attr('href')
      const fileurl = `https://moncompte.mediapart.fr/base/moncompte/${href}`
      const billId = href.match(/get_facture=([^&]+)/)[1]
      const title = `Mediapart ${billId} ${startDate} - ${endDate}`
      const filename = `mediapart_${billId}_${startDate}_${endDate}.pdf`
      const amount = parseFloat(price.replace(',', '.'))
      return {
        title,
        metadata,
        date,
        startDate,
        endDate,
        amount,
        vendor,
        billId,
        currency,
        filename,
        fileurl
      }
    })
    .get()

  // This table is different, need to be scrape separatly
  let listOfOlds = []
  if ($('table').length >= 2) {
    listOfOlds = $('table')
      .eq(1)
      .find('tr')
      .filter(function(idx) {
        // Filter 2 first lines of this table because of html junk
        return !(idx === 0 || idx === 1)
      })
      .map(function(idx, tr) {
        const re = /.*(\d\d\/\d\d\/\d\d\d\d).*(\d\d\/\d\d\/\d\d\d\d).*/
        const [, start, end] = $(tr)
          .find('td')
          .text()
          .trim()
          .match(re)
        const oStart = moment.utc(start, 'DD/MM/YYYY')
        const oEnd = moment.utc(end, 'DD/MM/YYYY')
        const startDate = oStart.format('YYYY-MM-DD')
        const endDate = oEnd.format('YYYY-MM-DD')
        const date = oEnd.toDate()
        const [price, currency] = $(tr)
          .find('td')
          .eq(1)
          .text()
          .trim()
          .split('\xa0') // Unbreakable space
        const href = $('a', tr)
          .first()
          .attr('href')
        const fileurl = `https://moncompte.mediapart.fr/base/moncompte/${href}`
        const billId = href.match(/get_facture=([^&]+)/)[1]
        const title = `Mediapart ${billId} ${startDate} - ${endDate}`
        const filename = `mediapart_${billId}_${startDate}_${endDate}.pdf`
        const amount = parseFloat(price.replace(',', '.'))
        return {
          title,
          metadata,
          date,
          startDate,
          endDate,
          amount,
          vendor,
          billId,
          currency,
          filename,
          fileurl
        }
      })
      .get()
  }
  return listOfRecents.concat(listOfOlds)
}
