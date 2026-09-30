const version=process.argv[2]||'1.2.13';
if(process.argv.includes('--version')) process.stdout.write(`agy ${version}\n`);
else process.exitCode=2;
