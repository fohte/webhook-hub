import { config } from '@fohte/eslint-config'

<<<<<<< before updating
export default config(
  {
    typescript: { typeChecked: true },
    errorHandling: {},
  },
  { ignores: ['dist/**'] },
)
||||||| last update
export default config(
  {
    typescript: { typeChecked: true },
    errorHandling: {},
  },
)
=======
export default config({
  typescript: { typeChecked: true },
  errorHandling: {},
})
>>>>>>> after updating
