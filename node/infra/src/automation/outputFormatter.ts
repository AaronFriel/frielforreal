import chalk from 'chalk';

export type Formatter = (str: string) => void;

let LONGEST_PREFIX = 50;
export function outputFormatter(title: string): Formatter {
  const prettify = chooseColor();

  if (title.length > LONGEST_PREFIX) {
    LONGEST_PREFIX = title.length;
  }
  const prefix = prettify(title.padEnd(LONGEST_PREFIX, ' '));

  return (msg: string): void => {
    const formattedMessage = msg
      .split('\n')
      .map((line) => `${prefix} | ${line.trimRight()}`)
      .join('\n');
    console.info(formattedMessage);
  };
}

const ALL_COLORS = [
  chalk.red,
  chalk.green,
  chalk.yellow,
  chalk.blue,
  chalk.magenta,
  chalk.cyan,
  chalk.white,
  chalk.gray,
  chalk.redBright,
  chalk.greenBright,
  chalk.yellowBright,
  chalk.blueBright,
  chalk.magentaBright,
  chalk.cyanBright,
]
  .map((f) => ({ f, sort: Math.random() }))
  .sort((a, b) => a.sort - b.sort)
  .map(({ f }) => f);
let COLOR_IDX = 0;
function chooseColor() {
  const colorChoice = ALL_COLORS[COLOR_IDX];
  COLOR_IDX = (COLOR_IDX + 1) % ALL_COLORS.length;

  return colorChoice;
}
