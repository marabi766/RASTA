# shellcheck shell=bash
# -----------------------------------------------------------------------------
# Pure helpers for create-topics.sh's `max.message.bytes` step (PR #378 r4 F2):
# no broker, no side effects, so scripts/kafka-topic-limits-lib.test.mjs runs
# them as they are. Sourced, never executed.
# -----------------------------------------------------------------------------

# dead_letter_limit <largest source limit> <added-header bound>
#
# The smallest limit a dead-letter topic gets over sources limited to the
# first argument: that, plus the bound on the headers the shared consumer adds,
# plus zlib's `deflateBound` growth of the sum and GZIP's 18-byte wrapper —
# `deadLetterMessageMaxBytes` in @rasta/contracts' dead-letter-size.ts, which
# the test compares this with. The growth is size-dependent (345 bytes at
# 1 MiB, 665 at 2 MiB), which is why a larger effective source limit needs
# more than the planned headroom.
dead_letter_limit() {
  local uncompressed=$(($1 + $2))
  echo $((uncompressed + uncompressed / 4096 + uncompressed / 16384 + uncompressed / 33554432 + 7 + 18))
}

# effective_limits < `kafka-configs.sh --describe --all --entity-type topics`
#
# One line per topic block, `<topic> <max.message.bytes> <source>`: the
# effective value — the topic's own override or what it inherits — and the
# synonym it comes from (DYNAMIC_TOPIC_CONFIG, DYNAMIC_DEFAULT_BROKER_CONFIG,
# STATIC_BROKER_CONFIG, DEFAULT_CONFIG, ...). Fails, saying why on stderr and
# printing nothing, on anything it cannot read for certain: a topic described
# twice, a block with no `max.message.bytes` or with two, a value that is not
# a positive int32 in decimal, a line without its synonym, a value outside any
# block. A topic the output does not describe at all is not printed; the caller
# compares the result with the topics the broker lists.
effective_limits() {
  awk '
    function refuse(why) { problem = why; failed = 1; exit 1 }
    /^All configs for topic [^ ]+ are:$/ {
      topic = $5
      if (topic in count) refuse("topic " topic " is described twice")
      count[topic] = 0
      next
    }
    /^[ \t]*max\.message\.bytes=/ {
      if (topic == "") refuse("max.message.bytes outside any topic block")
      if ($0 !~ /^  max\.message\.bytes=[1-9][0-9]* sensitive=false synonyms=\{[A-Z_]+:/)
        refuse(topic ": unreadable max.message.bytes line")
      value = substr($1, length("max.message.bytes=") + 1)
      if (length(value) > 10 || value + 0 > 2147483647)
        refuse(topic ": max.message.bytes " value " is not an int32")
      origin = substr($3, length("synonyms={") + 1)
      origin = substr(origin, 1, index(origin, ":") - 1)
      count[topic] += 1
      if (count[topic] > 1) refuse(topic ": max.message.bytes stated twice")
      limit[topic] = value
      source[topic] = origin
    }
    END {
      if (failed) { print "effective max.message.bytes: " problem > "/dev/stderr"; exit 1 }
      for (topic in count) {
        if (count[topic] != 1) {
          print "effective max.message.bytes: " topic ": no max.message.bytes" > "/dev/stderr"
          exit 1
        }
      }
      for (topic in count) print topic, limit[topic], source[topic]
    }
  '
}
